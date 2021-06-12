import evt from 'evt';

import { encodeInt as encodeA64 } from 'shared/a64';

/**
 * We want to allocate a concise attachment id that does not conflict with any
 * existing (or speculatively existing) attachments.  This function does this.
 * Is it maybe a bit overkill?  Yes, absolutely.  But does it get the job done?
 * Hopefully?  I mean, sure, this is all solid.
 */
function bruteForceAttachmentId(existingAttachments) {
  let existingIds = new Set();
  for (let att of existingAttachments) {
    existingIds.add(att.relId);
  }
  // So, in the simplest case (no detachments ever), using the current length
  // will work.  Or if the user detaches the most recenently attached
  // attachment.  But in Byzantine world, there can be conflicts.  However,
  // they're bounded by the limited coverage of the existing attachments and
  // sanity.  So really our only goal here is just to avoid a scenario where
  // a dumb linear scan is possible.  The below definitely avoids that and
  // probably most scenarios by a determined QA adversary.
  let ival = existingAttachments.length;
  let probeStep = 1;
  let relId;
  do {
    relId = encodeA64(ival);
    ival += probeStep;
    probeStep = 1 + Math.floor(Math.random() * existingAttachments.length);
  } while (existingIds.has(relId));

  return relId;
}

/**
 * Your scratchpad for storing your in-progress draft state and a place where
 * context-aware helpers live (or will live in the future).
 *
 * This is asynchronously initialized in the front-end from the same back-end
 * raw MessageInfo representation that is used to populate a MailMessage.
 *
 * If you don't have a draft MailMessage yet, then use
 * `MailMessage.replyToMessage`, `MailMessage.forwardMessage`, or
 * `MailAPI.beginMessageComposition`.  If you do have a MailMessage, use its
 * `MailMessage.editAsDraft` method.
 *
 * ## On Content and Blobs ##
 *
 * For `MailMessage` instances, body contents are stored in Blobs and accessing
 * them is fundamentaly an asynchronous process.  Getting an instance of this
 * class is inherently an asynchronous request already, so we unpack the text
 * Blob automatically.  Because the HTML is currently immutable and your UI
 * already needs to be able to handle this, the HTML blob is not unpacked.
 *
 * ## Life Cycle and Persistence ##
 *
 * Originally the back-end kept track of all open composition sessions, but this
 * turned out to not particularly be required or beneficial.  With the new task
 * infrastructure we have all draft logic implemented as tasks which implies
 * that all draft state is always persistent, thereby simplifying things.  The
 * only real issue is that we now are potentially much more likely to create
 * empty drafts that pile up if the user does not explicitly delete a draft and
 * our app ends up getting closed.
 *
 * Note that although composition sessions aren't tracked, each instance of us
 * keeps a live MailMessage around for updates, and so you do need to call
 * release when done with us.
 *
 * ## Drafts Have No Custom Rep ##
 *
 * We used to have a representation for drafts that we sent in both directions,
 * but it added complexity and made things more confusing.  (Note that the
 * requests we issue to save/update our draft state inherently have a wire
 * protocol of sorts, but it's really just argument propagation.)
 *
 * ## Other clients and drafts ##
 *
 * If the draft gets removed, a 'remove' event will fire.
 * TODO: That's not actually implemented yet, but the hookup in this class is.
 * So the todo is to remove this comment once the backend is clever enough.
 */
export default function MessageComposition(api) {
  evt.Emitter.call(this);
  this.api = api;
  this._message = null;

  this.senderIdentity = null;

  this.to = null;
  this.cc = null;
  this.bcc = null;

  this.subject = null;

  this.textBody = null;
  this.htmlBlob = null;

  this.serial = 0;

  this._references = null;
  /**
   * @property attachments
   * @type Object[]
   *
   * A list of attachments currently attached or currently being attached with
   * the following attributes:
   * - name: The filename
   * - size: The size of the attachment payload in binary form.  This does not
   *   include transport encoding costs.
   *
   * Manipulating this list has no effect on reality; the methods addAttachment
   * and removeAttachment must be used.
   */
  this.attachments = null;
}
MessageComposition.prototype = evt.mix({
  toString: function() {
    return '[MessageComposition: ' + this._handle + ']';
  },
  toJSON: function() {
    return {
      type: 'MessageComposition',
      handle: this._handle
    };
  },

  async __asyncInitFromMessage(message) {
    this._message = message;
    message.on('change', this._onMessageChange.bind(this));
    message.on('remove', this._onMessageRemove.bind(this));
    let wireRep = message._wireRep;
    this.serial++;

    this.id = wireRep.id;
    // TODO: use draftInfo to grab the MailSenderIdentity off the accounts, etc.
    this.subject = wireRep.subject;
    this.to = wireRep.to;
    this.cc = wireRep.cc;
    this.bcc = wireRep.bcc;
    this.attachments = wireRep.attachments;
    // For displaying "Send failed".
    this.sendProblems = wireRep.draftInfo.sendProblems;

    // HTML is optional, but if present, should satisfy our guard
    if (wireRep.bodyReps.length === 2 &&
        wireRep.bodyReps[1].type === 'html') {
      this.htmlBlob = wireRep.bodyReps[1].contentBlob;
    } else {
      this.htmlBlob = null;
    }

    const textRep = JSON.parse(await wireRep.bodyReps[0].contentBlob.text());
    if (Array.isArray(textRep) &&
        textRep.length === 2 &&
        textRep[0] === 0x1) {
      this.textBody = textRep[1];
    } else {
      this.textBody = '';
    }
    return this;
  },

  /**
   * Process change events reported by the MailMessage that we are a
   * representation of.
   *
   * We intentionally do not want to update when the subject/to/cc/bcc change.
   *
   * We do, however, care about the following right now:
   * - sendStatus: We want to reflect send errors.
   * And will care about in the future:
   * - attachments: When we start encoding these on demand as part of the send
   *   process and retain the Blob as a usable binary, we will want to just be
   *   a live view of the attachments from the message with the ability to
   *   expose the Blob for viewing and also detach it.  In the meantime, our
   *   local manipulations as we issue commands is sufficient.
   */
  _onMessageChange: function() {
    let wireRep = this._message._wireRep;
    this.sendStatus = wireRep.draftInfo.sendStatus;
    this.emit('change');
  },

  /**
   * Propagate the remove event.
   */
  _onMessageRemove: function() {
    this.emit('remove');
  },

  release: function() {
    if (this._message) {
      this._message.release();
      this._message = null;
    }
  },

  _mutated: function() {
    this.serial++;
    this.emit('change');
  },

  /**
   * Add an attachment to this composition.  This is an asynchronous process
   * that incrementally converts the Blob we are provided into a line-wrapped
   * base64-encoded message suitable for use in the rfc2822 message generation
   * process.  We will perform the conversion in slices whose sizes are
   * chosen to avoid causing a memory usage explosion that causes us to be
   * reaped.  Once the conversion is completed we will forget the Blob reference
   * provided to us.
   *
   * From the perspective of our drafts, an attachment is not fully attached
   * until it has been completely encoded, sliced, and persisted to our
   * IndexedDB database.  In the event of a crash during this time window,
   * the attachment will effectively have not been attached.  Our logic will
   * discard the partially-translated attachment when de-persisting the draft.
   * We will, however, create an entry in the attachments array immediately;
   * we also return it to you.  You should be able to safely call
   * removeAttachment with it regardless of what has happened on the backend.
   *
   * The caller *MUST* forget all references to the Blob that is being attached
   * after issuing this call.
   *
   * @args[
   *   @param[attachmentDef @dict[
   *     @key[name String]
   *     @key[blob Blob]
   *   ]]
   * ]
   */
  addAttachment: function(attachmentDef) {
    let relId = bruteForceAttachmentId(this.attachments);
    this.api._composeAttach(
      this.id,
      {
        relId,
        name: attachmentDef.name,
        blob: attachmentDef.blob
      });

    var placeholderAttachment = {
      relId,
      name: attachmentDef.name,
      type: attachmentDef.blob.type,
      sizeEstimate: attachmentDef.blob.size
    };
    this.attachments.push(placeholderAttachment);
    this._mutated();
    return placeholderAttachment;
  },

  /**
   * Remove an attachment previously requested to be added via `addAttachment`.
   *
   * @method removeAttachment
   * @param attachmentDef Object
   *   This must be one of the instances from our `attachments` list.  A
   *   logically equivalent object is no good.
   */
  removeAttachment: function(attachmentThing) {
    var idx = this.attachments.indexOf(attachmentThing);
    if (idx !== -1) {
      this.attachments.splice(idx, 1);
      this.api._composeDetach(this.id, attachmentThing.relId);
    }
    this._mutated();
  },

  /**
   * Optional helper function for to/cc/bcc list manipulation if you like the
   * 'change' events for managing UI state.
   */
  addRecipient: function(bin, addressPair) {
    this[bin].push(addressPair);
    this._mutated();
  },

  /**
   * Optional helper function for to/cc/bcc list manipulation if you like the
   * 'change' events for managing UI state.
   */
  removeRecipient: function(bin, addressPair) {
    let recipList = this[bin];
    let idx = recipList.indexOf(addressPair);
    if (idx !== -1) {
      recipList.splice(idx, 1);
      this._mutated();
    }
  },

  /**
   * Optional helper function for to/cc/bcc list manipulation if you like the
   * 'change' events for managing UI state.  Removes the last recipient in this
   * bin if there is one.
   */
  removeLastRecipient: function(bin) {
    let recipList = this[bin];
    if (recipList.length) {
      recipList.pop();
      this._mutated();
    }
  },

  setSubject: function(subject) {
    this.subject = subject;
    this._mutated();
  },

  /**
   * Populate our state to send over the wire to the back-end.
   */
  _buildWireRep: function() {
    return {
      // snapshot the timestamp of this state.
      date: Date.now(),
      to: this.to,
      cc: this.cc,
      bcc: this.bcc,
      subject: this.subject,
      textBody: this.textBody
    };
  },

  /**
   * Enqueue the message for sending. When the callback fires, the
   * message will be in the outbox, but will likely not have been sent yet.
   *
   * Returns a Promise that will be resolved with null if we expect the message
   * to be immediately sent, or one of the following strings if there is some
   * reason that it is not being sent.  Problems are listed by precedence; the
   * first error in the list that applies will be reported.  An error
   * - 'account-problem': There's some problem with the account that needs to be
   *   addressed before we will attempt to send the message.
   * - 'offline': The device is offline.  We need to be offline before we can
   *   send the message.
   * - 'outbox-paused': The outbox is paused by the UI for UX reasons.  When the
   *   outbox is unpaused, we fully expect to send the message.
   */
  finishCompositionSendMessage: function() {
    return this.api._composeDone(this.id, 'send', this._buildWireRep());
  },

  /**
   * Save the state of this composition.
   */
  saveDraft: function() {
    return this.api._composeDone(this.id, 'save', this._buildWireRep());
  },

  /**
   * The user has indicated they neither want to send nor save the draft.  We
   * want to delete the message so it is gone from everywhere.
   *
   * In the future, we might support some type of very limited undo
   * functionality, possibly on the UI side of the house.  This is not a secure
   * delete.
   */
  abortCompositionDeleteDraft: function() {
    return this.api._composeDone(this.id, 'delete', null);
  },

});

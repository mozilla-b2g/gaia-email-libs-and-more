define(function(require) {
'use strict';

let evt = require('evt');

let MailSenderIdentity = require('./mail_sender_identity');

let asyncFetchBlob = require('../async_blob_fetcher');

/**
 * Represents a draft that you're currently editing.  If you want to display a
 * draft, just use the `MailMessage`.  If you want to edit/compose, use
 * `MailMessage.replyToMessage`, `MailMessage.forwardMessage`,
 * `MailAPI.beginMessageComposition`, or `MailAPI.resumeMessageComposition`.
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
 * ## Drafts and their Wire Protocol ##
 *
 * The representation we send across the wire and receive is not the same as the
 * representation used for `MailMessage` instances.
 *
 * ## Other clients and drafts ##
 *
 * If another client deletes our draft out from under us, we currently won't
 * notice.  Some day we want to be able to recognize this (and not be tricked
 * into thinking what we ourselves did was done by someone else).
 */
function MessageComposition(api, handle) {
  this.api = api;
  this._handle = handle;

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

  __asyncInitFromWireRep: function(wireRep) {
    this.serial++;

    this.id = wireRep.id;
    this.senderIdentity = new MailSenderIdentity(this.api, wireRep.identity);
    this.subject = wireRep.subject;
    this.cc = wireRep.cc;
    this.to = wireRep.to;
    this.bcc = wireRep.bcc;
    this._references = wireRep.referencesStr;
    this.attachments = wireRep.attachments;
    this.sendStatus = wireRep.sendStatus; // For displaying "Send failed".

    this.htmlBlob = wireRep.htmlBlob;
    return asyncFetchBlob(wireRep.body.textBlob, 'json').then((textRep) => {
      if (Array.isArray(textRep) &&
          textRep.length === 2 &&
          textRep[0] === 0x1) {
        this.textBody = textRep[1];
      } else {
        this.textBody = '';
      }
    });
  },

  release: function() {
    if (this._handle) {
      this.api._composeDone(this._handle, 'release', null, null);
      this._handle = null;
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
  addAttachment: function(attachmentDef, callback) {
    this.api._composeAttach(this.id, attachmentDef, callback);

    var placeholderAttachment = {
      name: attachmentDef.name,
      blob: {
        size: attachmentDef.blob.size,
        type: attachmentDef.blob.type
      }
    };
    this.attachments.push(placeholderAttachment);
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
  removeAttachment: function(attachmentDef, callback) {
    var idx = this.attachments.indexOf(attachmentDef);
    if (idx !== -1) {
      this.attachments.splice(idx, 1);
      this.api._composeDetach(this._handle, idx, callback);
    }
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
      senderId: this.senderIdentity.id,
      to: this.to,
      cc: this.cc,
      bcc: this.bcc,
      subject: this.subject,
      body: this.body,
      referencesStr: this._references,
      attachments: this.attachments,
    };
  },

  /**
   * Enqueue the message for sending. When the callback fires, the
   * message will be in the outbox, but will likely not have been sent yet.
   *
   * TODO: Return a promise that indicates whether we're actively trying to
   * send the message or whether it's just queued for future sending because
   * we're offline.  (UI can currently infer from other channels/data.)
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

return MessageComposition;
});

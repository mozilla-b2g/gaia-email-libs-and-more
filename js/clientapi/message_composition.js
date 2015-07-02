define(function(require) {
'use strict';

let MailSenderIdentity = require('./mail_sender_identity');

/**
 * Handle for a current/ongoing message composition process.  The UI reads state
 * out of the object when it resumes editing a draft, otherwise this can just be
 * treated as write-only.
 *
 * == Other clients and drafts:
 *
 * If another client deletes our draft out from under us, we currently won't
 * notice.
 */
function MessageComposition(api, wireRep, handle) {
  this._api = api;
  this._handle = handle;

  this.senderIdentity = null;

  this.to = null;
  this.cc = null;
  this.bcc = null;

  this.subject = null;

  this.body = null;

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

  this.hasDraft = false;
}
MessageComposition.prototype = {
  toString: function() {
    return '[MessageComposition: ' + this._handle + ']';
  },
  toJSON: function() {
    return {
      type: 'MessageComposition',
      handle: this._handle
    };
  },

  __update: function(msg) {
    this.id = msg.id;
    this.senderIdentity = new MailSenderIdentity(this._api, msg.identity);
    this.subject = msg.subject;
    this.body = msg.body; // rich obj of {text, html}
    this.cc = msg.cc;
    this.to = msg.to;
    this.bcc = msg.bcc;
    this._references = msg.referencesStr;
    this.attachments = msg.attachments;
    this.sendStatus = msg.sendStatus; // For displaying "Send failed".
  },

  release: function() {
    if (this._handle) {
      this._api._composeDone(this._handle, 'release', null, null);
      this._handle = null;
    }
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
    // There needs to be a draft for us to attach things to.
    if (!this.hasDraft)
      this.saveDraft();
    this._api._composeAttach(this.id, attachmentDef, callback);

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
      this._api._composeDetach(this._handle, idx, callback);
    }
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
    this._api._composeDone(this._handle, 'send', this._buildWireRep(),
                           callback);
  },

  /**
   * Save the state of this composition.
   */
  saveDraft: function() {
    this.hasDraft = true;
    this._api._composeDone(this._handle, 'save', this._buildWireRep(),
                           callback);
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
    this._api._composeDone(this._handle, 'delete', null, callback);
  },

};

return MessageComposition;
});

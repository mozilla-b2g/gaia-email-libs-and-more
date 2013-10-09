/**
 * Composition stuff.
 **/

define(
  [
    'mailcomposer',
    'mailapi/mailchew',
    'mailapi/util',
    'exports'
  ],
  function(
    $mailcomposer,
    $mailchew,
    $imaputil,
    exports
  ) {

// Exports to make it easier for other modules to just require
// this module, but get access to these useful dependencies.
exports.mailchew = $mailchew;
exports.MailComposer = $mailcomposer;

/*
 * mailcomposer monkeypatch to handle pre-encoded attachment blobs
 *
 * We pre-encode all attachments, so they do not need to be encoded by the
 * mailcomposer library.  When we see a Blob we flush any existing string buffer
 * to be an output blob piece and then push the attachment blobs.
 *
 */
$mailcomposer.MailComposer.prototype._realEmitDataElement =
  $mailcomposer.MailComposer.prototype._emitDataElement;
$mailcomposer.MailComposer.prototype._emitDataElement = function(element,
                                                                 callback) {
  if (element.contents && element.contents instanceof Blob) {
    if (this._outputBuffer) {
console.warn('pushing1', this._outputBuffer);
      this._outputBlobPieces.push(this._outputBuffer);
      this._outputBuffer = '';
    }
    this._outputBlobPieces.push(element.contents);

    callback();
    return;
  }

  this._realEmitDataElement(element, callback);
};

/**
 * Abstraction around the mailcomposer helper library and our efforts to avoid
 * filling up the device's memory and crashing when we send large messages.  We
 * produce a Blob that is made up of some combination of strings and Blobs.
 *
 * ## Composer Endpoints ##
 *
 * There are 3 main endpoints for our data:
 *
 * 1) SMTP transmission.  SMTP does not require us to know the size of what we
 * are sending up front.  It usually does NOT want the BCC header included in
 * the message.
 *
 * 2) IMAP APPEND.  APPEND needs to know the size of the message we are
 * appending up front.  It DOES want the BCC header included for archival
 * purposes, so this needs to be a different body.
 *
 * 3) ActiveSync sending.  There are actually two paths here; ActiveSync <= 12.x
 * does a more traditional POST of just the MIME data.  ActiveSync >= 14.0
 * generates a WBXML command, but it's basically just a wrapper around the MIME
 * data.  Because we use XHR's to communicate with the server, the size
 * effectively needs to be known ahead of time.
 *
 * ## The Data ##
 *
 * The actual data that goes into our message is either finite-ish (headers),
 * variable in size but arguably manageable (the contents of the message), or
 * potentially very large in size (attachments).  Besides being potentially
 * huge, attachments are also notable because they are immutable once attached.
 * Also, they arguably need to be redundantly stored once attached.  That is,
 * if a user attaches an image from DeviceStorage and then later deletes it
 * before the message is sent, you can make a convincing case that the
 * attachment should still be sent with the message.  Previously, this would
 * happen as a side-effect of IndexedDB's need to duplicate the contents of
 * Blobs passed into it so it could persist them and manage its life-cycle.
 *
 * @param newRecords
 *   The HeaderInfo and BodyInfo for the most recent saved copy of the draft.
 * @param account
 * @param identity {
 */
function Composer(newRecords, account, identity) {
  this.header = newRecords.header;
  this.body = newRecords.body;
  this.account = account;
  this.identity = identity;

  this._asyncPending = 0;
  this._deferredCalls = [];

  this.sentDate = new Date(this.header.date);
  // - snapshot data we create for consistency
  // we're copying nodemailer here; we might want to include some more...
  this.messageId =
    '<' + Date.now() + Math.random().toString(16).substr(1) + '@mozgaia>';

  this._mcomposer = null;
  this._mcomposerOpts = null;
  this._outputBlob = null;
  this._buildMailComposer();

  this._attachments = [];

  // - fetch attachments if sending
  if (this.body.attachments.length) {
    this.body.attachments.forEach(function(attachment) {
      try {
        this._attachments.push({
          fileName: attachment.name,
          contentType: attachment.type,
          // Drafts have their pre-encoded contents stored as a list of Blobs.
          // We normalize these into an aggregate Blob.  Said aggregage Blob
          // will eventually get aggregated into the giant aggregate Blob that
          // is the whole message; we could be more efficient, but it's not
          // believed to matter and makes the types/etc. more obvious.
          contents: new Blob(attachment.file),
        });
      }
      catch (ex) {
        console.error('Problem attaching attachment:', ex, '\n', ex.stack);
      }
    }.bind(this));
  }
  // TODO: relatedParts when we support them
}
exports.Composer = Composer;
Composer.prototype = {
  _buildMailComposer: function() {
    var header = this.header, body = this.body;
    var mcomposer = this._mcomposer = new $mailcomposer.MailComposer();

    var messageOpts = {
      from: $imaputil.formatAddresses([this.identity]),
      subject: header.subject,
    };
    // - HTML and text
    var textBody = body.bodyReps[0];
    if (body.bodyReps.length === 2) {
      var htmlBody = body.bodyReps[1];
      messageOpts.html = $mailchew.mergeUserTextWithHTML(
        textBody.content[1], htmlBody.content);
    }
    else {
      messageOpts.body = textBody.content[1];
    }

    if (this.identity.replyTo)
      messageOpts.replyTo = this.identity.replyTo;
    if (header.to && header.to.length)
      messageOpts.to = $imaputil.formatAddresses(header.to);
    if (header.cc && header.cc.length)
      messageOpts.cc = $imaputil.formatAddresses(header.cc);
    if (header.bcc && header.bcc.length)
      messageOpts.bcc = $imaputil.formatAddresses(header.bcc);
    mcomposer.setMessageOption(messageOpts);

    mcomposer.addHeader('User-Agent', 'Mozilla Gaia Email Client 0.1alpha3');
    mcomposer.addHeader('Date', this.sentDate.toUTCString());

    mcomposer.addHeader('Message-Id', this.messageId);
    if (body.references)
      mcomposer.addHeader('References', body.references);
  },

  /**
   * Build the body consistent with the requested options.  If this is our
   * first time building a body, we can use the existing _mcomposer.  If the
   * opts are the same as last time, we can reuse the built body.  If the opts
   * have changed, we need to create a new _mcomposer because it accumulates
   * state and then generate the body.
   */
  _ensureBodyWithOpts: function(opts) {
    // reuse the existing body if possible
    if (this._mcomposerOpts &&
        this._mcomposerOpts.includeBcc === opts.includeBcc) {
      return;
    }
    // if we already build a body, we need to create a new mcomposer
    if (this._mcomposerOpts !== null)
      this._buildMailComposer();
    // save the opts for next time
    this._mcomposerOpts = opts;
    // it's fine to directly clobber this in
    this._mcomposer.options.keepBcc = opts.includeBcc;

    for (var iAtt = 0; iAtt < this._attachments.length; iAtt++) {
      this._mcomposer.addAttachment(this._attachments[iAtt]);
    }

    // Render the message to its output buffer.
    var mcomposer = this._mcomposer;
    mcomposer._cacheOutput = true;
    mcomposer._outputBlobPieces = [];
    process.immediate = true;
    mcomposer._processBufferedOutput = function() {
      // we are stopping the DKIM logic from firing.
    };
    mcomposer._composeMessage();
    process.immediate = false;

    if (mcomposer._outputBuffer) {
console.warn('pushing2', mcomposer._outputBuffer);
      mcomposer._outputBlobPieces.push(mcomposer._outputBuffer);
      mcomposer._outputBuffer = '';
    }
    this._outputBlob = new Blob(mcomposer._outputBlobPieces);
  },

  _asyncLoadsCompleted: function() {
    while (this._deferredCalls.length) {
      var toCall = this._deferredCalls.shift();
      toCall();
    }
  },

  getEnvelope: function() {
    return this._mcomposer.getEnvelope();
  },

  /**
   * Request that a body be produced as a single Blob with the given options.
   * Multiple calls to this method can be made and they may overlap.
   *
   * @args[
   *   @param[opts @dict[
   *     @key[includeBcc Boolean]{
   *       Should we include the BCC data in the headers?
   *     }
   *   ]]
   *   @param[callback @func[
   *     @args[
   *       @param[messageBlob Blob]
   *     ]
   *   ]]
   * ]
   */
  withMessageBlob: function(opts, callback) {
    if (this._asyncPending) {
      this._deferredCalls.push(
        this.withMessageBlob.bind(this, opts, callback));
      return;
    }

    this._ensureBodyWithOpts(opts);
    callback(this._outputBlob);
  },
};

}); // end define

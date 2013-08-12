/**
 * Composition stuff.
 **/

define(
  [
    'mailcomposer',
    './mailchew',
    './util',
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

/**
 * Abstraction around the mailcomposer helper library and our efforts to avoid
 * filling up the device's memory and crashing when we send large messages.  We
 * produce a Blob that is made up of some combination of strings and Blobs.
 *
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
 * However, the problem with letting IndexedDB do this is that our internal
 * storage is modeled as extremely limited.
 *
 *
 */
function Composer(mode, wireRep, account, identity) {
  this.mode = mode;
  this.wireRep = wireRep;
  this.account = account;
  this.identity = identity;

  this._asyncPending = 0;
  this._deferredCalls = [];

  // - snapshot data we create for consistency
  // we create now so multiple MailComposer creations will
  // have the same values.
  this.sentDate = new Date();
  // we're copying nodemailer here; we might want to include some more...
  this.messageId =
    '<' + Date.now() + Math.random().toString(16).substr(1) + '@mozgaia>';

  this._mcomposer = null;
  this._mcomposerOpts = null;
  this._buildMailComposer();

  this._attachments = [];

  // - fetch attachments if sending
  if (mode === 'send' && wireRep.attachments) {
    wireRep.attachments.forEach(function(attachmentDef) {
      var reader = new FileReaderSync();
      try {
        this._attachments.push({
          filename: attachmentDef.name,
          contentType: attachmentDef.blob.type,
          contents: new Uint8Array(reader.readAsArrayBuffer(attachmentDef.blob)),
        });
      }
      catch (ex) {
        console.error('Problem attaching attachment:', ex, '\n', ex.stack);
      }
    }.bind(this));
  }
}
exports.Composer = Composer;
Composer.prototype = {
  _buildMailComposer: function() {
    var wireRep = this.wireRep, body = wireRep.body;
    var mcomposer = this._mcomposer = new $mailcomposer.MailComposer();

    var messageOpts = {
      from: $imaputil.formatAddresses([this.identity]),
      subject: wireRep.subject,
    };
    if (body.html) {
      messageOpts.html = $mailchew.mergeUserTextWithHTML(body.text, body.html);
    }
    else {
      messageOpts.body = body.text;
    }

    if (this.identity.replyTo)
      messageOpts.replyTo = this.identity.replyTo;
    if (wireRep.to && wireRep.to.length)
      messageOpts.to = $imaputil.formatAddresses(wireRep.to);
    if (wireRep.cc && wireRep.cc.length)
      messageOpts.cc = $imaputil.formatAddresses(wireRep.cc);
    if (wireRep.bcc && wireRep.bcc.length)
      messageOpts.bcc = $imaputil.formatAddresses(wireRep.bcc);
    mcomposer.setMessageOption(messageOpts);

    if (wireRep.customHeaders) {
      for (var iHead = 0; iHead < wireRep.customHeaders.length; iHead += 2){
        mcomposer.addHeader(wireRep.customHeaders[iHead],
                           wireRep.customHeaders[iHead+1]);
      }
    }
    mcomposer.addHeader('User-Agent', 'Mozilla Gaia Email Client 0.1alpha2');
    mcomposer.addHeader('Date', this.sentDate.toUTCString());

    mcomposer.addHeader('Message-Id', this.messageId);
    if (wireRep.referencesStr)
      mcomposer.addHeader('References', wireRep.referencesStr);
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
    process.immediate = true;
    mcomposer._processBufferedOutput = function() {
      // we are stopping the DKIM logic from firing.
    };
    mcomposer._composeMessage();
    process.immediate = false;

    // (the data is now in mcomposer._outputBuffer)
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
   * Request that a body be produced as a single buffer with the given options.
   * Multiple calls to this method can be made and they may overlap.
   *
   * XXX: Currently, the callback is invoked with a String instead of an
   * ArrayBuffer/node-like Buffer; consumers that do not use TextEncoder to
   * produce a utf-8 encoding probably need to and we might want to change this
   * here.
   *
   * @args[
   *   @param[opts @dict[
   *     @key[includeBcc Boolean]{
   *       Should we include the BCC data in the headers?
   *     }
   *   ]]
   *   @param[callback @func[
   *     @args[
   *       @param[messageBuffer String]
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
    callback(this._mcomposer._outputBuffer);
  },
};

}); // end define

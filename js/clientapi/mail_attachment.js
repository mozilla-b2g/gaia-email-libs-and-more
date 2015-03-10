define(function(require) {
'use strict';


/**
 * Provides the file name, mime-type, and estimated file size of an attachment.
 * In the future this will also be the means for requesting the download of
 * an attachment or for attachment-forwarding semantics.
 */
function MailAttachment(_body, wireRep) {
  this._body = _body;
  this.partId = wireRep.part;
  this.filename = wireRep.name;
  this.mimetype = wireRep.type;
  this.sizeEstimateInBytes = wireRep.sizeEstimate;
  this._file = wireRep.file;

}
MailAttachment.prototype = {
  toString: function() {
    return '[MailAttachment: "' + this.filename + '"]';
  },
  toJSON: function() {
    return {
      type: 'MailAttachment',
      filename: this.filename
    };
  },

  __update: function(wireRep) {
    this.mimetype = wireRep.type;
    this.sizeEstimateInBytes = wireRep.sizeEstimate;
    this._file = wireRep.file;
  },

  get isDownloaded() {
    return !!this._file;
  },

  /**
   * Is this attachment something we can download?  In almost all cases, the
   * answer is yes, regardless of network state.  The exception is that sent
   * POP3 messages do not retain their attachment Blobs and there is no way to
   * download them after the fact.
   */
  get isDownloadable() {
    return this.mimetype !== 'application/x-gelam-no-download';
  },

  download: function(callWhenDone, callOnProgress) {
    if (this.isDownloaded) {
      callWhenDone();
      return;
    }
    this._body._api._downloadAttachments(
      this._body, [], [this._body.attachments.indexOf(this)],
      callWhenDone, callOnProgress);
  },
};

return MailAttachment;
});

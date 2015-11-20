define(function() {
'use strict';

var evt = require('evt');

/**
 * Provides the file name, mime-type, and estimated file size of an attachment.
 * In the future this will also be the means for requesting the download of
 * an attachment or for attachment-forwarding semantics.
 */
function MailAttachment(_message, wireRep) {
  evt.Emitter.call(this);

  this._message = _message;
  // Create an absolute id that uniquely identifies the attachment.  (There's
  // no API that cares about this id yet, though.)
  this.id = _message.id + '.' + wireRep.relId;
  // The unique id for the attachment on this message.  Not unique elsewhere.
  this.relId = wireRep.relId;
  // The IMAP part number for this attachment.  If you need this for anything
  // other than debugging, then it's a sad day for all.
  this.partId = wireRep.part;
  this.filename = wireRep.name;
  this.mimetype = wireRep.type;
  this.sizeEstimateInBytes = wireRep.sizeEstimate;
  this._file = wireRep.file;

  this.__updateDownloadOverlay(null);
}
MailAttachment.prototype = evt.mix({
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

  /**
   * Since we're not first-class and instead owned by the MailMessage, only it
   * gets proper updates and so it has to spoon-feed us
   */
  __updateDownloadOverlay: function(info) {
    if (info) {
      let changed = (this.downloadStatus !== info.status);
      this.downloadStatus = info.status;
      this.bytedDownloaded = info.bytesDownloaded;
    } else {
      this.downloadStatus = null;
      this.bytesDownloaded = 0;
    }
  },

  get isDownloading() {
    return !!this.downloadStatus;
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

  /**
   * Queue this attachment for downloading.
   *
   * @param {Function} callWhenDone
   *     A callback to be invoked when the download completes.
   * @param {Function} callOnProgress
   *     A callback to be invoked as the download progresses.  NOT HOOKED UP!
   * @param {Boolean} [registerWithDownloadManager]
   *     Should we register the Blob with the mozDownloadManager (if it is
   *     present)?  For the Gaia mail app this decision is based on the
   *     capabilities of the default gaia apps, and not a decision easily made
   *     by GELAM.
   */
  download: function() {
    if (this.isDownloaded || this.isDownloading) {
      return;
    }
    this._message._api._downloadAttachments({
      messageId: this._message.id,
      messageDate: this._message.date.valueOf(),
      relatedPartRelIds: null,
      attachmentRelIds: [this.relId]
    });
  },
});

return MailAttachment;
});

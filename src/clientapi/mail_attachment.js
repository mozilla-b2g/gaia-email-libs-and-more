import evt from 'evt';

/**
 * Provides the file name, mime-type, and estimated file size of an attachment.
 * In the future this will also be the means for requesting the download of
 * an attachment or for attachment-forwarding semantics.
 */
export default function MailAttachment(_message, wireRep) {
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

  this.__update(wireRep);
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
    this.filename = wireRep.name;
    this.mimetype = wireRep.type;
    this.sizeEstimateInBytes = wireRep.sizeEstimate;
    this._downloadState = wireRep.downloadState;
    this._file = wireRep.file;
  },

  /**
   * Since we're not first-class and instead owned by the MailMessage, only it
   * gets proper updates and so it has to spoon-feed us
   */
  __updateDownloadOverlay: function(info) {
    if (info) {
      this._overlayDownloadStatus = info.status;
      this.bytesDownloaded = info.bytesDownloaded;
    } else {
      this.downloadStatus = null;
      this.bytesDownloaded = 0;
    }
  },

  /**
   * The very, very detailed download state.  The values will be one of the
   * following:
   * - null: not downloading, not downloaded.
   * - 'pending': A download is queued but we haven't started it yet.
   * - 'active': We are actively downloading this attachment.
   * - 'cached': It's downloaded, but we've only temporarily stored it in
   *   IndexedDB and it could go away for various reasons.  You can access it
   *   via `getDownloadedBlob`.
   * - 'saved': It's permanently downloaded AS FAR AS WE KNOW.  We saved it to
   *   DeviceStorage and we tried to register it with the download manager.  You
   *   can ask for it via `getDownloadedBlob` but it's possible that the user
   *   might have delete it and we don't know and we'll reject the Promise and
   *   everyone will be sad.  Eventually we want to more actively notice this
   *   scenario and automatically recover from this state.
   */
  get downloadState() {
    return this._downloadState || this._overlayDownloadStatus;
  },

  get isDownloading() {
    return !!this._overlayDownloadStatus;
  },

  /**
   * Is the file downloaded and available to access via `getDownloadedBlob`.
   */
  get isDownloaded() {
    // Our download state knows the answer, but also sanity-check that the file
    // is there.
    return (this._downloadState === 'cached' ||
            this._downloadState === 'saved') &&
           this._file;
  },

  /**
   * Is this attachment something we can download?  In almost all cases, the
   * answer is yes, regardless of network state.  The exceptions are:
   * - Sent POP3 messages do not retain their attachment Blobs and there is no
   *   way to download them after the fact.
   * - Draft messages under composition currently store their attachment in an
   *   encoded state that we can't turn back into a usable File.  It's our plan
   *   to stop doing this and instead store them as 'cached' or some cached
   *   variant where they're explicitly immune to automated discarding.
   */
  get isDownloadable() {
    return (this.mimetype !== 'application/x-gelam-no-download') &&
           this._downloadState !== 'draft';
  },

  /**
   * Queue this attachment for downloading.
   *
   * @param {'cache'|'download'} [opts.target='save']
   *   What should we do with the file when we've downloaded it?
   *   - 'save' (the default): Save the file to the catch-all 'sdcard'
   *     DeviceStorage and track it with the download manager (if available on
   *     the current platform).  If you want to support a mode of saving to
   *     device storage without registering with the download manager, do ask
   *     for it.  I removed that ability in the convoy transition because we
   *     decided to always track all downloads with the download manager.
   *   - 'cache': Store it in IndexedDB as a cache that will be removed when the
   *     message is removed.  Also, potentially subject to cache eviction when
   *     other cache-targeted downloads occur or for other complicated storage
   *     reasons that may or may not eventually get implemented.
   *
   * Returns a promise that will be resolved when this attachment and any other
   * pending downloads on the parent message complete downloading.  (That is,
   * it is subject to batching/aggregation; don't use this Promise if you only
   * care about this specific attachment and something else might be triggering
   * other downloads from the message.)  We will also generate 'change' updates
   * on our parent object and this attachment when the download completes, so in
   * most UI cases, you don't need/want to care about the promise.
   *
   * Relevant notes:
   * - The promise will be resolved even if our owning MailMessage and this
   *   attachment are no longer alive/updating.
   * - Even if you are being naive and the download is already in progress (or
   *   already completed), the Promise we return will be smart and join up
   *   with the already pending task.
   * - We will also potentially send a number of spurious 'update' events on
   *   this attachments and any siblings.  (As of writing this, attachments
   *   all update whenever their parent message updates.)
   */
  download: function(opts) {
    let downloadTarget = opts && opts.downloadTarget || 'save';
    return this._message._api._downloadAttachments({
      messageId: this._message.id,
      messageDate: this._message.date.valueOf(),
      parts: new Map([[this.relId, downloadTarget]])
    });
  },

  /**
   * If isDownloaded currently returns true, then we will return a Promise that
   * will be resolved with the Blob is still around, or rejected if not still
   * around.  Specifically, if downloadState is 'cached', you'll definitely get
   * it resolved.  But if downloadState is 'saved', it's possible the file no
   * longer exists on DeviceStorage and we'll have to reject.
   *
   * If isDownloaded currently returns false, we'll also reject for consistency,
   * but you are being silly.  This is also the case for when we're currently
   * downloading.  If you want to trigger something when the download completes,
   * you need to use download() first.  You also need to make sure that you
   * still have a live MailMessage instance.  If the message is owned by a
   * (windowed) view, then it could be released by the time you need it.  Use
   * `MailAPI.getMessage` in that case.
   */
  getDownloadedBlob: function() {
    if (!this.isDownloaded) {
      return Promise.reject();
    }
    if (this._downloadState === 'cached') {
      return Promise.resolve(this._file);
    }
    return new Promise((resolve, reject) => {
      try {
        // Get the file contents as a blob, so we can open the blob
        var storageType = this._file[0];
        var filename = this._file[1];
        var storage = navigator.getDeviceStorage(storageType);
        var getreq = storage.get(filename);

        getreq.onerror = function() {
          reject(getreq.error);
          console.warn('Could not open attachment file: ', filename,
                       getreq.error.name);
        };

        getreq.onsuccess = function() {
          // Now that we have the file, return the blob within callback function
          resolve(getreq.result);
        };
      } catch (ex) {
        console.warn('Exception getting attachment from device storage:',
                     ex, '\n', ex.stack);
        reject(ex);
      }
    });
  },
});

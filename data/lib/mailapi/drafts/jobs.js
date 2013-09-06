/**
 *
 **/

define(function(require, exports) {

////////////////////////////////////////////////////////////////////////////////
// attachBlobToDraft
//
//

/**
 * Asynchronously fetch the contents of a Blob, returning a binary string.
 * Exists because there is no FileReader in Gecko workers and this totally
 * works.  In discussion, it sounds like :sicking wants to deprecate the
 * FileReader API anyways.
 *
 * Our consumer in this case wants a binary string so we can easily do
 * window.btoa() on it.  Blobs are out by definition, arraybuffers don't really
 * help.  Everything else is more structured.  moz-chunked-text is workable but
 * is non-standard and creates bounary conditions for our consumer because it
 * works in chunks.
 */
function asyncFetchBlobAsBinaryString(blob, callback) {
  var blobUrl = URL.createObjectURL(blob);
  var xhr = new XMLHttpRequest();
  xhr.open('GET', blobUrl, true);
  // binary string, regardless of the source
  xhr.overrideMimeType('text\/plain; charset=x-user-defined');
  xhr.onload = function() {
    // blobs currently result in a status of 0 since there is no server.
    if (xhr.status !== 0 && (xhr.status < 200 || xhr.status >= 300)) {
      callback(xhr.status);
      return;
    }
    callback(null, xhr.responseText);
  };
  xhr.onerror = function() {
    callback('error');
  };
  xhr.send();
  URL.revokeObjectURL(blobUrl);
}

/**
 * Incrementally convert an attachment into its base64 encoded attachment form
 * which we save in chunks to IndexedDB to avoid using too much memory now or
 * during the sending process.
 *
 * - Retrieve the body the draft is persisted to,
 * - Repeat until the attachment is fully attached:
 *   - take a chunk of the source attachment
 *   - base64 encode it into a Blob
 *   - update the body with that Blob
 *   - trigger a save of the account so that IndexedDB writes the account to
 *     disk.
 *   - force the body block to be discarded from the cache and then re-get the
 *     body.  We won't be saving any memory until the Blob has been written to
 *     disk and we have forgotten all references to the in-memory Blob we wrote
 *     to the database.  (The Blob does not magically get turned into a
 *     reference to the database.)
 * - Be done.
 */
exports.local_do_attachBlobToDraft = function(op, callback) {
  var localDraftsFolder = this.account.getFirstFolderWithType('localdrafts');
  if (!localDraftsFolder) {
    callback('moot');
    return;
  }
  var self = this;
  this._accessFolderForMutation(
    localDraftsFolder.id, /* needConn*/ false,
    function(nullFolderConn, folderStorage) {

      var nextOffset = 0;

      function convertNextChunk() {
        var slicedBlob =

        if (--waitingFor === 0) {
          callback(
            null,
            { suid: header.suid, date: header.date },
            /* save account */ true);
        }
      }
      var waitingFor = 2;

      var header = op.header, body = op.body;
      // fill-in header id's
      header.id = folderStorage._issueNewHeaderId();
      header.suid = folderStorage.folderId + '/' + header.id;

      // If there already was a draft saved, delete it.
      // Note that ordering of the removal and the addition doesn't really
      // matter here because of our use of transactions.
      if (op.existingNamer) {
        waitingFor++;
        folderStorage.deleteMessageHeaderAndBody(
          op.existingNamer.suid, op.existingNamer.date, next);
      }

      folderStorage.addMessageHeader(header, next);
      folderStorage.addMessageBody(header, body, next);
    },
    /* no conn => no deathback required */ null,
    'attachBlobToDraft');
};
exports.do_attachBlobToDraft = function(op, callback) {
  // there is no server component for this
  callback(null);
};
exports.check_attachBlobToDraft = function(op, callback) {
  callback(null, 'moot');
};
exports.local_undo_attachBlobToDraft = function(op, callback) {
  callback(null);
};
exports.undo_attachBlobToDraft = function(op, callback) {
  callback(null);
};

////////////////////////////////////////////////////////////////////////////////
// saveDraft

/**
 * Save a draft; if there already was a draft, it gets replaced.  The new
 * draft gets a new date and id/SUID so it is logically distinct.  However,
 * we will propagate attachment and on-server information between drafts.
 */
exports.local_do_saveDraft = function(op, callback) {
  var localDraftsFolder = this.account.getFirstFolderWithType('localdrafts');
  if (!localDraftsFolder) {
    callback('moot');
    return;
  }
  var self = this;
  this._accessFolderForMutation(
    localDraftsFolder.id, /* needConn*/ false,
    function(nullFolderConn, folderStorage) {
      function next() {
        if (--waitingFor === 0) {
          callback(
            null,
            { suid: header.suid, date: header.date },
            /* save account */ true);
        }
      }
      var waitingFor = 2;

      var header = op.header, body = op.body;
      // fill-in header id's
      header.id = folderStorage._issueNewHeaderId();
      header.suid = folderStorage.folderId + '/' + header.id;

      // If there already was a draft saved, delete it.
      // Note that ordering of the removal and the addition doesn't really
      // matter here because of our use of transactions.
      if (op.existingNamer) {
        waitingFor++;
        folderStorage.deleteMessageHeaderAndBody(
          op.existingNamer.suid, op.existingNamer.date, next);
      }

      folderStorage.addMessageHeader(header, next);
      folderStorage.addMessageBody(header, body, next);
    },
    /* no conn => no deathback required */ null,
    'saveDraft');
};

/**
 * FUTURE WORK: Save a draft to the server; this is inherently IMAP only.
 * Tracked on: https://bugzilla.mozilla.org/show_bug.cgi?id=799822
 *
 * It is very possible that we will save local drafts faster / more frequently
 * than we can update our server state.  It only makes sense to upload the
 * latest draft state to the server.  Because we delete our old local drafts,
 * it's obvious when we should skip out on updating the server draft for
 * something.
 *
 * Because IMAP drafts have to replace the prior drafts, we use our old 'srvid'
 * to know what message to delete as well as what message to pull attachments
 * from when we're in a mode where we upload attachments to drafts and CATENATE
 * is available.
 */
exports.do_saveDraft = function(op, callback) {
  callback(null);
};
exports.check_saveDraft = function(op, callback) {
  callback(null, 'moot');
};
exports.local_undo_saveDraft = function(op, callback) {
  callback(null);
};
exports.undo_saveDraft = function(op, callback) {
  callback(null);
};

////////////////////////////////////////////////////////////////////////////////
// deleteDraft

exports.local_do_deleteDraft = function(op, callback) {
  var localDraftsFolder = this.account.getFirstFolderWithType('localdrafts');
  if (!localDraftsFolder) {
    callback('moot');
    return;
  }
  var self = this;
  this._accessFolderForMutation(
    localDraftsFolder.id, /* needConn*/ false,
    function(nullFolderConn, folderStorage) {
      folderStorage.deleteMessageHeaderAndBody(
        op.messageNamer.suid, op.messageNamer.date,
        function() {
          callback(null, null, /* save account */ true);
        });
    },
    /* no conn => no deathback required */ null,
    'deleteDraft');
};

exports.do_deleteDraft = function(op, callback) {
  // there is no server component for this
  callback(null);
};
exports.check_deleteDraft = function(op, callback) {
  callback(null, 'moot');
};
exports.local_undo_deleteDraft = function(op, callback) {
  callback(null);
};
exports.undo_deleteDraft = function(op, callback) {
  callback(null);
};

////////////////////////////////////////////////////////////////////////////////

}); // end define

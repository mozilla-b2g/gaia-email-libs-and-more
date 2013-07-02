/**
 *
 **/

define(function(require, exports) {

////////////////////////////////////////////////////////////////////////////////
// attachBlobToDraft
//
//

exports.local_do_attachBlobToDraft = function(op, callback) {
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

exports.do_saveDraft = function(op, callback) {
  // there is no server component for this
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
//
//

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

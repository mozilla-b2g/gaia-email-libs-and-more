define(function(require) {

/**
 * Owns the synchronization state of a folder.  It is responsible for
 * maintaining the conversation and message view slices of folders as well as
 * being the convenience API for synchronization logic mucking with this state.
 *
 * Our state changes only as a result of synchronization logic run against us.
 * These are issued as coherent batches against us and the other database reps.
 */
function FolderSyncDB() {
  /**
   *
   */
  this._orderedMessages = [];

  this._convIdToNewestMessage = new Map();

  this._orderedConversations = [];
}
FolderSyncDB.prototype = {

};

return FolderSyncDB;
});

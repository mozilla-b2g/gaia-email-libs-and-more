define(function(require) {

let a64 = require('../a64');
let RefedResource = require('../refed_resource');
let compareMsgIds = a64.cmpUI64;

/**
 * Owns the synchronization state of a folder.  It is responsible for
 * maintaining the computed conversation and message arrays of folders as well
 * as being the convenience API for synchronization logic mucking with this
 * state.
 *
 * Our state changes only as a result of synchronization logic run against us.
 * These are issued as coherent batches against us and the other database reps.
 */
function FolderSyncDB(db, folderId) {
  RefedResource.call(this);

  this._db = db;
  this.folderId = folderId;

  /**
   * @typedef {Number} InternalDateTS
   * The INTERNALDATE of an IMAP message expressed as milliseconds since the
   * epoch.
   */
  /**
   * @typedef {A64String} GmailMsgId
   * The gmail-assigned 64-bit unsigned X-GM-MSGID expressed in a64 form.
   */
  /**
   * @typedef {A64String} GmailConvId
   * The gmail-assigned 64-bit unsigned X-MSG-THRID expressed in a64 form.
   */
  /**
   * @typedef {Object} FolderPerMessageInfo
   * @property {UID} uid
   * @property {InternalDateTS} date
   * @property {GmailMsgId} msgId
   * @property {GmailConvId} convId
   */

   this.__deinit();
}
FolderSyncDB.prototype = RefedResource.mix({
  /**
   * Reset our internal state; this is used for initial setup and if we ever
   * forget our state for memory-saving reasons.  This state is intentionally
   * the valid state for a new folder (for which we have no existing state).
   * This is an arbitrary call but is good for type stability.
   */
  __deinit: function() {
    this.oldestSyncDateTS = 0;

    /**
     * @type {Array<FolderPerMessageInfo>}
     * The messages in the folder, ordered from newest to oldest by the composite
     * key of [date, msgId].
     */
    this.orderedMessages = [];
    /**
     * @type {Map<GmailConvId, FolderPerMessageInfo>}
     * Maps the conversation to the record identifying the most recent message in
     * the folder that belongs to the conversation.  Note that the message may not
     * be the most recent in the conversation; labels are per-message, not
     * per-conversation.
     */
    this.convIdToNewestMessage = new Map();

    this.orderedConversations = [];
  },

  __init: co.wrap(function* _init() {
    let dbState = yield this._db.loadFolderSyncData(this.folderId);
    if (dbState) {
      this.orderedMessages = dbState.messages;
      this._fullyDeriveConversations();
    }
  }),

  /**
   * Process
   */
  deriveConversations: function(msgInfos) {
    let convIdToNewest = this.convIdToNewestMessage = new Map();
    let convs = this.orderedConversations = [];
    for (let folderMsgInfo of this.orderedMessages) {
      let convId = folderMsgInfo.convId;
      // Keep going if we already know about this conversation.
      if (convIdToNewest.has(convId)) {
        continue;
      }

      convIdToNewest.set(convId, folderMsgInfo);
      convs.push(convId);
    }
  },


  /**
   * Comparator so messages get ordered newest to oldest by the composite key
   * of [date, msgId].
   */
  messageOrderingComparator: function(a, b) {
    let dateDelta = b.date - a.date;
    if (dateDelta) {
      return dateDelta;
    }
    return compareMsgIds(b.msgId, a.msgId);
  },

  youAreDeadCleanUpAfterYourself: function() {
    // XXX TODO actually do this and this really should be done as part of a
    // task cascade.  See our callers for more todo-y comments.
  }
});

return FolderSyncDB;
});

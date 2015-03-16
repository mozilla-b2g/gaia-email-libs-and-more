define(function(require) {

var a64 = require('../a64');

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

  this._initPromise = this._init();
}
FolderSyncDB.prototype = {
  _init: co.wrap(function* _init() {
    this._orderedMessages = yield this._db.loadFolderSyncData(this.folderId);

    this._deriveConversations();

    this._initPromise = null;
  }),

  _deriveConversations: function() {
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
  }
};

return FolderSyncDB;
});

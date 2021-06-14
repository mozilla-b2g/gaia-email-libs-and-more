import logic from 'logic';

import { encodeInt } from 'shared/a64';

/**
 * Account global sync state.  Which is really just the FolderSync syncKey
 * which we dub the hierarchySyncKey because talking about the "folder syncKey"
 * and "FolderSync syncKey" is way too confusing.
 *
 * Note that currently since the "folderInfo" object store stores the folder as
 * a single atomic aggregate with a meta structure, we alternately could have
 * used that.  But it seems quite possible that our account sync state will
 * eventually need to store more.  It's definitely useful as a locking construct
 * (under mutation rules).  And most importantly, during the development of the
 * convoy refactor, I've found myself thinking we definitely want the FolderInfo
 * structures to be something that can be updated independently in transactions
 * and, again, which potentially serve as important locking constructs.
 *
 * Our sync state contains:
 * - hierarchySyncKey
 * - nextFolderId.  NB: In IMAP it's still using the folder info meta-meta.
 * - serverIdToFolderId: A Map from the server-provided serverId to the folderId
 *   we internally use.
 *
 * Our sync key explicitly does *not* contain:
 * - The default filterType.  This is a user setting and as such needs to be
 *   stored on the accountDef so it propagates through upgrades, etc.
 */
export default function AccountSyncStateHelper(ctx, rawSyncState, accountId) {
  if (!rawSyncState) {
    logic(ctx, 'creatingDefaultSyncState', {});
    rawSyncState = {
      hierarchySyncKey: '0',
      nextFolderNum: 0,
      serverIdToFolderId: new Map()
    };
  }

  this._ctx = ctx;
  this._accountId = accountId;
  this.rawSyncState = rawSyncState;
  this.serverIdToFolderId = rawSyncState.serverIdToFolderId;
}
AccountSyncStateHelper.prototype = {
  get hierarchySyncKey() {
    return this.rawSyncState.hierarchySyncKey;
  },

  set hierarchySyncKey(val) {
    this.rawSyncState.hierarchySyncKey = val;
  },

  issueFolderId: function() {
    return (
      this._accountId + '.' + encodeInt(this.rawSyncState.nextFolderNum++));
  },

  addedFolder: function(serverId, folderInfo) {
    this.serverIdToFolderId.set(serverId, folderInfo);
  },

  removedFolder: function(serverId) {
    this.serverIdToFolderId.delete(serverId);
  }
};

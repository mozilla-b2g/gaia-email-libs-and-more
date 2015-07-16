define(function(require) {
'use strict';

let co = require('co');

let TaskDefiner = require('../../task_definer');

const FolderSyncStateHelper = require('../folder_sync_state_helper');

const modifyFolderMessages = require('../smotocol/modify_folder_messages');

/**
 * @see MixStoreFlagsMixin
 */
return TaskDefiner.defineComplexTask([
  require('../../imap/vanilla_tasks/mix_store_flags'),
  {
    name: 'store_flags',

    execute: co.wrap(function*(ctx, persistentState, memoryState,
                               marker) {
      let { umidChanges } = persistentState;

      let changes = umidChanges.get(marker.umid);

      let account = yield ctx.universe.acquireAccount(ctx, marker.accountId);

      // -- Read the umidLocation
      let fromDb = yield ctx.read({
        umidLocations: new Map([[marker.umid, null]])
      });

      let [folderId, messageServerId] = fromDb.umidLocations.get(marker.umid);

      // -- Exclusive access to the sync state needed for the folder syncKey
      fromDb = yield ctx.beginMutate({
        syncStates: new Map([[folderId, null]])
      });
      let rawSyncState = fromDb.syncStates.get(folderId);
      let syncState = new FolderSyncStateHelper(
        ctx, rawSyncState, marker.accountId, folderId);

      let folderInfo = account.getFolderById(folderId);

      let conn = yield account.ensureConnection();

      let readMap = new Map();
      let flagMap = new Map();

      if (changes.add) {
        if (changes.add.indexOf('\\Seen') !== -1) {
          readMap.set(messageServerId, true);
        }
        if (changes.add.indexOf('\\Flagged') !== -1) {
          flagMap.set(messageServerId, true);
        }
      }
      if (changes.remove) {
        if (changes.remove.indexOf('\\Seen') !== -1) {
          readMap.set(messageServerId, false);
        }
        if (changes.remove.indexOf('\\Flagged') !== -1) {
          flagMap.set(messageServerId, false);
        }
      }

      syncState.syncKey = (yield* modifyFolderMessages(
        conn,
        {
          folderServerId: folderInfo.serverId,
          folderSyncKey: syncState.syncKey,
          read: readMap,
          flag: flagMap
        })).syncKey;

      // - Success, clean up state.
      umidChanges.delete(marker.umid);

      // - Return / finalize
      yield ctx.finishTask({
        syncStates: new Map([[folderId, syncState.rawSyncState]]),
        complexTaskState: persistentState
      });
    })
  }
]);
});

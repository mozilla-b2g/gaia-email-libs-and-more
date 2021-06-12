import TaskDefiner from '../../../task_infra/task_definer';

import FolderSyncStateHelper from '../folder_sync_state_helper';

import modifyFolderMessages from '../smotocol/modify_folder_messages';

import MixinStoreFlags from '../../../task_mixins/mix_store_flags';

/**
 * @see MixStoreFlagsMixin
 */
export default TaskDefiner.defineComplexTask([
  MixinStoreFlags,
  {
    name: 'store_flags',

    async execute(ctx, persistentState, memoryState, marker) {
      let { umidChanges } = persistentState;

      let changes = umidChanges.get(marker.umid);

      let account = await ctx.universe.acquireAccount(ctx, marker.accountId);

      // -- Read the umidLocation
      let fromDb = await ctx.read({
        umidLocations: new Map([[marker.umid, null]])
      });

      let [folderId, messageServerId] = fromDb.umidLocations.get(marker.umid);

      // -- Exclusive access to the sync state needed for the folder syncKey
      fromDb = await ctx.beginMutate({
        syncStates: new Map([[folderId, null]])
      });
      let rawSyncState = fromDb.syncStates.get(folderId);
      let syncState = new FolderSyncStateHelper(
        ctx, rawSyncState, marker.accountId, folderId);

      let folderInfo = account.getFolderById(folderId);

      let conn = await account.ensureConnection();

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

      syncState.syncKey = (await modifyFolderMessages(
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
      await ctx.finishTask({
        syncStates: new Map([[folderId, syncState.rawSyncState]]),
        complexTaskState: persistentState
      });
    }
  }
]);

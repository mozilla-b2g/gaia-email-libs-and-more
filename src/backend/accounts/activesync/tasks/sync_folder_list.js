import evt from 'evt';
import TaskDefiner from '../../../task_infra/task_definer';

import normalizeFolder from '../normalize_folder';
import AccountSyncStateHelper from '../account_sync_state_helper';

import enumerateHierarchyChanges from '../smotocol/enum_hierarchy_changes';

import MixinSyncFolderList from '../../../task_mixins/mix_sync_folder_list';

/**
 * Sync the folder list for an ActiveSync account.  We leverage IMAP's mix-in
 * for the infrastructure (that wants to move someplace less IMAPpy.)
 */
export default TaskDefiner.defineSimpleTask([
  MixinSyncFolderList,
  {
    essentialOfflineFolders: [
      // Although the inbox is an online folder, we aren't daring enough to
      // predict its server id, so it will be fixed up later, so we just
      // leave it starting out as offline.  (For Microsoft servers, I believe
      // the inbox does have a consistent guid, but we can't assume Microsoft.)
      {
        type: 'inbox',
        displayName: 'Inbox'
      },
      {
        type: 'outbox',
        displayName: 'outbox'
      },
      {
        type: 'localdrafts',
        displayName: 'localdrafts'
      },
    ],

    async syncFolders(ctx, account) {
      let foldersTOC = account.foldersTOC;
      let conn = await account.ensureConnection();
      let newFolders = [];
      let modifiedFolders = new Map();

      let fromDb = await ctx.beginMutate({
        syncStates: new Map([[account.id, null]])
      });

      let rawSyncState = fromDb.syncStates.get(account.id);
      let syncState = new AccountSyncStateHelper(
        ctx, rawSyncState, account.id);

      let emitter = new evt.Emitter();
      let deferredFolders = [];

      function tryAndAddFolder(folderArgs) {
        let maybeFolderInfo = normalizeFolder(
          {
            idMaker: foldersTOC.issueFolderId.bind(syncState),
            serverIdToFolderId: syncState.serverIdToFolderId,
            folderIdToFolderInfo: foldersTOC.foldersById
          },
          {
            serverId: folderArgs.ServerId,
            parentServerId: folderArgs.ParentId,
            displayName: folderArgs.DisplayName,
            typeNum: folderArgs.Type
          }
        );
        if (maybeFolderInfo === null) {
          deferredFolders.push(folderArgs);
        } else if (maybeFolderInfo === true) {
          // - we updated the inbox!
          // tell the sync state about our ID mapping.
          syncState.addedFolder(maybeFolderInfo);
          modifiedFolders.set(maybeFolderInfo.id, maybeFolderInfo);
        } else {
          // - totally new folder
          // the syncState needs to know the mapping
          syncState.addedFolder(maybeFolderInfo);
          // plus we should actually surface the folder to the UI
          newFolders.push(maybeFolderInfo);
        }
      }

      emitter.on('add', (folderArgs) => {
        tryAndAddFolder(folderArgs);
      });
      emitter.on('remove', (serverId) => {
        syncState.removedFolder(serverId);
        let folderId = syncState.serverIdToFolderId.get(serverId);
        modifiedFolders.set(folderId, null);
      });

      syncState.hierarchySyncKey = (await enumerateHierarchyChanges(
        conn,
        { hierarchySyncKey: syncState.hierarchySyncKey, emitter }
      )).hierarchySyncKey;

      // It's possible we got some folders in an inconvenient order (i.e. child
      // folders before their parents). Keep trying to add folders until we're
      // done.
      while (deferredFolders.length) {
        let processFolders = deferredFolders;
        deferredFolders = [];
        for (let folder of processFolders) {
          tryAndAddFolder(folder);
        }
        if (processFolders.length === deferredFolders.length) {
          throw new Error('got some orphaned folders');
        }
      }

      return {
        newFolders,
        modifiedFolders,
        modifiedSyncStates: new Map([[account.id, syncState.rawSyncState]])
      };
    }
  }
]);

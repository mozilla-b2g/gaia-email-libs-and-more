define(function(require) {
'use strict';

const co = require('co');
const evt = require('evt');
const TaskDefiner = require('../../task_definer');

const normalizeFolder = require('../normalize_folder');
const AccountSyncStateHelper = require('../account_sync_state_helper');

const enumerateHierarchyChanges = require('../smotocol/enum_hierarchy_changes');


/**
 * Sync the folder list for an ActiveSync account.  We leverage IMAP's mix-in
 * for the planning phase.  It's a 50/50 thing on the execute case; we need our
 * sync state, which would bloat the mixin.
 */
return TaskDefiner.defineSimpleTask([
  require('../../imap/vanilla_tasks/mix_sync_folder_list'),
  {
    execute: co.wrap(function*(ctx, req) {
      let account = yield ctx.universe.acquireAccount(ctx, req.accountId);
      let foldersTOC = account.foldersTOC;
      let conn = yield account.ensureConnection();

      let fromDb = yield ctx.beginMutate({
        syncStates: new Map([[req.accountId, null]])
      });

      let rawSyncState = fromDb.syncStates.get(req.accountId);
      let syncState = new AccountSyncStateHelper(
        ctx, rawSyncState, req.accountId);

      let emitter = new evt.Emitter();
      let deferredFolders = [];

      function tryAndAddFolder(folderArgs) {
        let maybeFolderInfo = normalizeFolder(
          {
            idMaker: syncState.issueFolderId.bind(syncState),
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
        } else if (maybeFolderInfo !== true) {
          syncState.addedFolder(maybeFolderInfo);
          foldersTOC.addFolder(maybeFolderInfo);
        }
      }

      emitter.on('add', (folderArgs) => {
        tryAndAddFolder(folderArgs);
      });
      emitter.on('remove', (serverId) => {
        syncState.removedFolder(serverId);
        let folderId = syncState.serverIdToFolderId.get(serverId);
        foldersTOC.foldersTOC.removeFolderById(folderId);
      });

      syncState.hierarchySyncKey = (yield* enumerateHierarchyChanges(
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

      yield ctx.finishTask({
        mutations: {
          syncStates: new Map([[req.accountId, syncState.rawSyncState]]),
          folders: new Map([
            [account.id, account.foldersTOC.generatePersistenceInfo()]
          ]),
        },
        // all done!
        taskState: null
      });
    })
  }
]);
});

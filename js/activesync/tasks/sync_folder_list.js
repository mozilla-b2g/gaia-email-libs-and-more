define(function(require) {
'use strict';

const co = require('co');
const evt = require('evt');
const TaskDefiner = require('../../task_definer');

const normalizeFolder = require('../normalize_folder');
const AccountSyncStateHelper = require('../account_sync_state_helper');

const enumerateHierarchyChanges = require('../smotocol/enum_hierarchy_changes');

const { makeFolderMeta } = require('../../db/folder_info_rep');

/**
 * Sync the folder list for an ActiveSync account.  We leverage IMAP's mix-in
 * for the planning phase.  It's a 50/50 thing on the execute case; we need our
 * sync state, which would bloat the mixin.
 */
return TaskDefiner.defineSimpleTask([
  require('../../imap/vanilla_tasks/mix_sync_folder_list'),
  {
    essentialOfflineFolders: [
      // The inbox is special; we are creating it so that we have an id for it
      // even before we talk to the server.  This makes life easier for UI
      // logic even in weird account creation setups.  The one trick is that
      // the normalizeFolder function and our online step have to be clever to
      // fix-up this speculative folder to be a real folder.
      {
        type: 'inbox',
        // A previous comment indicated the title-case is intentional, although
        // I think our l10n hacks don't care nor does our fixup logic.
        displayName: 'Inbox'
      },
      {
        type: 'outbox',
        displayName: 'outbox'
      },
      {
        type: 'localdrafts',
        displayName: 'localdrafts'
      }
    ],

    ensureEssentialOfflineFolders: co.wrap(function*(ctx, account, mutations) {
      let foldersTOC = account.foldersTOC;

      // See if we actually need to create some folders.
      let toCreate = this.essentialOfflineFolders.filter((desired) => {
        if (foldersTOC.getCanonicalFolderByType(desired.type) === null) {
          return true;
        }
      });

      if (!toCreate.length) {
        return false;
      }

      // - Gain mutation locks
      let fromDb = yield ctx.beginMutate({
        syncStates: new Map([[account.id, null]])
      });

      let rawSyncState = fromDb.syncStates.get(account.id);
      let syncState = new AccountSyncStateHelper(
        ctx, rawSyncState, account.id);

      // - Create the folders
      toCreate.forEach((desired) => {
        foldersTOC.addFolder(makeFolderMeta({
          id: syncState.issueFolderId(),
          serverId: null,
          name: desired.displayName,
          type: desired.type,
          path: desired.displayName,
          parentId: null,
          depth: 0,
          lastSyncedAt: 0
        }));
      });

      // We need to update the sync state since we allocated a folder id
      mutations.syncStates = new Map([[account.id, syncState.rawSyncState]]);
      // And we need to tell the other logic that we changed something and the
      // folders needs to be flushed.
      return true;
    }),

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
        } else if (maybeFolderInfo === true) {
          // - we updated the inbox!
          // tell the sync state about our ID mapping.
          syncState.addedFolder(maybeFolderInfo);
        } else {
          // - totally new folder
          // the syncState needs to know the mapping
          syncState.addedFolder(maybeFolderInfo);
          // plus we should actually surface the folder to the UI
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

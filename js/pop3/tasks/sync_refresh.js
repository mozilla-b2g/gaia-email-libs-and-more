define(function(require) {
'use strict';

const co = require('co');
const { shallowClone } = require('../../util');

const { NOW } = require('../../date');

const TaskDefiner = require('../../task_infra/task_definer');

const SyncStateHelper = require('../sync_state_helper');

const { POP3_MAX_MESSAGES_PER_SYNC } = require('../../syncbase');

return TaskDefiner.defineAtMostOnceTask([
  {
    name: 'sync_refresh',
    binByArg: 'folderId',

    helped_overlay_folders: function(folderId, marker, inProgress) {
      if (!marker) {
        return null;
      } else if (inProgress) {
        return 'active';
      } else {
        return 'pending';
      }
    },

    /**
     * In our planning phase we discard nonsensical requests to refresh
     * local-only folders.
     */
    helped_plan: function(ctx, rawTask) {
      // - Plan!
      let plannedTask = shallowClone(rawTask);
      plannedTask.exclusiveResources = [
        `sync:${rawTask.folderId}`
      ];
      plannedTask.priorityTags = [
        `view:folder:${rawTask.folderId}`
      ];

      return Promise.resolve({
        taskState: plannedTask,
        announceUpdatedOverlayData: [['folders', rawTask.folderId]]
      });
    },

    helped_execute: co.wrap(function*(ctx, req) {
      // Our overlay logic will report us as active already, so send the update
      // to avoid inconsistencies.  (Alternately, we could mutate the marker
      // with non-persistent changes.)
      ctx.announceUpdatedOverlayData('folders', req.folderId);

      // -- Exclusively acquire the sync state for the folder
      let fromDb = yield ctx.beginMutate({
        syncStates: new Map([[req.accountId, null]])
      });
      let rawSyncState = fromDb.syncStates.get(req.accountId);
      let syncState = new SyncStateHelper(
        ctx, rawSyncState, req.accountId, 'refresh',
        POP3_MAX_MESSAGES_PER_SYNC);

      // -- Establish the connection
      let syncDate = NOW();
      let account = yield ctx.universe.acquireAccount(ctx, req.accountId);
      let popAccount = account.popAccount;

      let conn = yield popAccount.ensureConnection();

      // -- Infer the UIDLs that are new to us and bin for sync and overflow.
      // Potential enhancement: loadMessageList combines UIDL and LIST.  Our
      // size needs are on-demand enough that we could only issue one-off LIST
      // requests.
      let allMessages = yield conn.loadMessageList();

      syncState.deltaCheckUidls(allMessages);

      return {
        mutations: {
          syncStates: new Map([[req.accountId, syncState.rawSyncState]]),
          umidNames: syncState.umidNameWrites,
          umidLocations: syncState.umidLocationWrites
        },
        newData: {
          tasks: syncState.tasksToSchedule
        },
        atomicClobbers: {
          folders: new Map([
            [
              req.folderId,
              {
                lastSuccessfulSyncAt: syncDate,
                lastAttemptedSyncAt: syncDate,
                failedSyncsSinceLastSuccessfulSync: 0
              }
            ]])
        },
        announceUpdatedOverlayData: [['folders', req.folderId]]
      };
    })
  }
]);
});

import { shallowClone } from 'shared/util';

import { NOW } from 'shared/date';

import TaskDefiner from '../../../task_infra/task_definer';

import SyncStateHelper from '../sync_state_helper';

import { POP3_MAX_MESSAGES_PER_SYNC } from '../../../syncbase';

export default TaskDefiner.defineAtMostOnceTask([
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

    helped_invalidate_overlays: function(folderId, dataOverlayManager) {
      dataOverlayManager.announceUpdatedOverlayData('folders', folderId);
    },

    helped_already_planned: function(ctx, rawTask) {
      // The group should already exist; opt into its membership to get a
      // Promise
      return Promise.resolve({
        result: ctx.trackMeInTaskGroup('sync_refresh:' + rawTask.folderId)
      });
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

      // Create a task group that follows this task and all its offspring.  This
      // will define the lifetime of our overlay as well.
      let groupPromise =
        ctx.trackMeInTaskGroup('sync_refresh:' + rawTask.folderId);
      return Promise.resolve({
        taskState: plannedTask,
        remainInProgressUntil: groupPromise,
        result: groupPromise
      });
    },

    async helped_execute(ctx, req) {
      // -- Exclusively acquire the sync state for the folder
      let fromDb = await ctx.beginMutate({
        syncStates: new Map([[req.accountId, null]])
      });
      let rawSyncState = fromDb.syncStates.get(req.accountId);
      let syncState = new SyncStateHelper(
        ctx, rawSyncState, req.accountId, 'refresh',
        POP3_MAX_MESSAGES_PER_SYNC);

      // -- Establish the connection
      let syncDate = NOW();
      let account = await ctx.universe.acquireAccount(ctx, req.accountId);
      let popAccount = account.popAccount;

      let conn = await popAccount.ensureConnection();

      // -- Infer the UIDLs that are new to us and bin for sync and overflow.
      // Potential enhancement: loadMessageList combines UIDL and LIST.  Our
      // size needs are on-demand enough that we could only issue one-off LIST
      // requests.
      let allMessages = await conn.loadMessageList();

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
        }
      };
    }
  }
]);

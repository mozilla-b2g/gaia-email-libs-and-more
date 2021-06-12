import logic from 'logic';

import ICAL from 'ical.js';

import { shallowClone } from 'shared/util';
import { NOW } from 'shared/date';

import TaskDefiner from '../../../task_infra/task_definer';

import SyncStateHelper from '../sync_state_helper';

import { accountIdFromFolderId } from 'shared/id_conversions';

import { syncNormalOverlay, syncPrefixOverlay } from
  '../../../task_helpers/sync_overlay_helpers';

/**
 * Sync a folder for the first time and steady-state.  See `../sync.md` for some
 * info.
 *
 * ## Dynamic Folders / Labels
 *
 * The most notable thing about Bugzilla (Differential) sync compared to
 * messaging is that we locally generate synthetic categorical labels which
 * means that every sync has the potential to create new folders and so we
 */
export default TaskDefiner.defineAtMostOnceTask([
  {
    name: 'sync_refresh',
    binByArg: 'accountId',

    helped_overlay_accounts: syncNormalOverlay,

    /**
     * We will match folders that belong to our account, allowing us to provide
     * overlay data for folders even though we are account-centric.
     * Our overlay push happens indirectly by us announcing on
     * 'accountCascadeToFolders' which causes the folders_toc to generate the
     * overlay pushes for all impacted folders.
     */
    helped_prefix_overlay_folders: [
      accountIdFromFolderId,
      syncPrefixOverlay
    ],

    helped_invalidate_overlays: function(accountId, dataOverlayManager) {
      dataOverlayManager.announceUpdatedOverlayData(
        'accounts', accountId);
      dataOverlayManager.announceUpdatedOverlayData(
        'accountCascadeToFolders', accountId);
    },

    helped_already_planned: function(ctx, rawTask) {
      // The group should already exist; opt into its membership to get a
      // Promise
      return Promise.resolve({
        result: ctx.trackMeInTaskGroup('sync_refresh:' + rawTask.accountId)
      });
    },

    helped_plan: function(ctx, rawTask) {
      // - Plan!
      let plannedTask = shallowClone(rawTask);
      plannedTask.resources = [
        'online',
        `credentials!${rawTask.accountId}`,
        `happy!${rawTask.accountId}`
      ];
      // Let our triggering folder's viewing give us a priority boost, Although
      // perhaps this should just be account granularity?
      plannedTask.priorityTags = [
        `view:folder:${rawTask.folderId}`
      ];

      // Create a task group that follows this task and all its offspring.  This
      // will define the lifetime of our overlay as well.
      let groupPromise =
        ctx.trackMeInTaskGroup('sync_refresh:' + rawTask.accountId);
      return Promise.resolve({
        taskState: plannedTask,
        remainInProgressUntil: groupPromise,
        result: groupPromise
      });
    },

    async helped_execute(ctx, req) {
      // -- Exclusively acquire the sync state for the account
      let fromDb = await ctx.beginMutate({
        syncStates: new Map([[req.accountId, null]])
      });
      let rawSyncState = fromDb.syncStates.get(req.accountId);

      let syncState = new SyncStateHelper(ctx, rawSyncState, req.accountId,
                                          'refresh');

      let account = await ctx.universe.acquireAccount(ctx, req.accountId);

      let syncDate = NOW();
      logic(ctx, 'syncStart', { syncDate });

      // ### Fetch the calendar.
      const icalResp = await fetch(account.calendarUrl);
      const icalText = await icalResp.text();

      const parsed = ICAL.parse(icalText);
      const root = new ICAL.Component(parsed);
      for (const event of root.getAllSubcomponents('vevent')) {
        syncState.ingestEvent(event);
      }
      syncState.processEvents();

      logic(ctx, 'syncEnd', {});

      return {
        mutations: {
          syncStates: new Map([[req.accountId, syncState.rawSyncState]]),
        },
        newData: {
          tasks: syncState.tasksToSchedule
        },
        atomicClobbers: {
          accounts: new Map([
            [
              req.accountId,
              {
                syncInfo: {
                  lastSuccessfulSyncAt: syncDate,
                  lastAttemptedSyncAt: syncDate,
                  failedSyncsSinceLastSuccessfulSync: 0
                }
              }
            ]])
        }
      };
    }
  }
]);

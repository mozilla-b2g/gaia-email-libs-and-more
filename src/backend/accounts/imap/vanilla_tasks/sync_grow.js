import logic from 'logic';

import { shallowClone } from 'shared/util';

import TaskDefiner from '../../../task_infra/task_definer';

import { quantizeDate, NOW } from 'shared/date';

import * as imapchew from '../imapchew';
const parseImapDateTime = imapchew.parseImapDateTime;

import FolderSyncStateHelper from '../vanilla/folder_sync_state_helper';

import { OLDEST_SYNC_DATE, SYNC_WHOLE_FOLDER_AT_N_MESSAGES,
        GROWTH_MESSAGE_COUNT_TARGET } from '../../../syncbase';

import { syncNormalOverlay } from '../../../task_helpers/sync_overlay_helpers';

import MixinImapProbeForDate from '../task_mixins/imap_mix_probe_for_date';

/**
 * Expand the date-range of known messages for the given folder.
 *
 * This is now relatively clever and uses the following two heuristics to ensure
 * that we always learn about at least one message:
 * - If there's only a small number of messages in the folder that we don't
 *   know about, we just move our sync range to be everything since the oldest
 *   sync date.  TODO: In the future change this to have us remove date
 *   constraints entirely.  It's likely much friendlier to the server to do
 *   this.
 * - Use sequence numbers to figure out an appropriate date to use to grow our
 *   date-based sync window.  This is intended to help us bridge large time
 *   gaps between messages.
 */
export default TaskDefiner.defineAtMostOnceTask([
  MixinImapProbeForDate,
  {
    name: 'sync_grow',
    binByArg: 'folderId',

    helped_overlay_folders: syncNormalOverlay,

    helped_invalidate_overlays(folderId, dataOverlayManager) {
      dataOverlayManager.announceUpdatedOverlayData('folders', folderId);
    },

    helped_already_planned(ctx, rawTask) {
      // The group should already exist; opt into its membership to get a
      // Promise
      return Promise.resolve({
        result: ctx.trackMeInTaskGroup('sync_grow:' + rawTask.folderId)
      });
    },

    helped_plan(ctx, rawTask) {
      let plannedTask = shallowClone(rawTask);
      plannedTask.resources = [
        'online',
        `credentials!${rawTask.accountId}`,
        `happy!${rawTask.accountId}`
      ];
      plannedTask.priorityTags = [
        `view:folder:${rawTask.folderId}`
      ];

      // Create a task group that follows this task and all its offspring.  This
      // will define the lifetime of our overlay as well.
      let groupPromise =
        ctx.trackMeInTaskGroup('sync_grow:' + rawTask.folderId);
      return Promise.resolve({
        taskState: plannedTask,
        remainInProgressUntil: groupPromise,
        result: groupPromise
      });
    },

    async helped_execute(ctx, req) {
      // -- Exclusively acquire the sync state for the folder
      let fromDb = await ctx.beginMutate({
        syncStates: new Map([[req.folderId, null]])
      });

      let syncState = new FolderSyncStateHelper(
        ctx, fromDb.syncStates.get(req.folderId), req.accountId,
        req.folderId, 'grow');

      // -- Enter the folder to get an estimate of the number of messages
      let account = await ctx.universe.acquireAccount(ctx, req.accountId);
      let folderInfo = account.getFolderById(req.folderId);
      let mailboxInfo = await account.pimap.selectMailbox(ctx, folderInfo);

      // Figure out an upper bound on the number of messages in the folder that
      // we have not synchronized.
      let estimatedUnsyncedMessages =
        mailboxInfo.exists - syncState.knownMessageCount;

      // -- Issue a search for the new date range we're expanding to cover.
      let searchSpec = { not: { deleted: true } };

      let existingSinceDate = syncState.sinceDate;
      let newSinceDate;

      // If there are fewer messages left to sync than our constant for this
      // purpose, then just set the date range to our oldest sync date.
      if (!isNaN(estimatedUnsyncedMessages) &&
          estimatedUnsyncedMessages < Math.max(SYNC_WHOLE_FOLDER_AT_N_MESSAGES,
                                               GROWTH_MESSAGE_COUNT_TARGET)) {
        newSinceDate = OLDEST_SYNC_DATE;
      } else {
        newSinceDate = await this._probeForDateUsingSequenceNumbers({
          ctx, account, folderInfo,
          startSeq: mailboxInfo.exists - syncState.knownMessageCount,
          curDate: existingSinceDate || quantizeDate(NOW())
        });
      }

       if (existingSinceDate) {
        searchSpec.before = new Date(quantizeDate(existingSinceDate));
      }
      searchSpec.since = new Date(newSinceDate);

      let syncDate = NOW();

      logic(ctx, 'searching', { searchSpec: searchSpec });
      // Find out new UIDs covering the range in question.
      let { result: uids } = await account.pimap.search(
        ctx, folderInfo, searchSpec, { byUid: true });

      // -- Fetch flags and the dates for the new messages
      // We want the date so we can prioritize the synchronization of the
      // message.  We want the flags because the sync state needs to persist and
      // track the flags so it can detect changes in flags in sync_refresh.
      if (uids.length) {
        let newUids = syncState.filterOutKnownUids(uids);

        let { result: messages } = await account.pimap.listMessages(
          ctx,
          folderInfo,
          newUids,
          [
            'UID',
            'INTERNALDATE',
            'FLAGS'
          ],
          { byUid: true }
        );

        for (let msg of messages) {
          let dateTS = parseImapDateTime(msg.internaldate);
          syncState.yayMessageFoundByDate(msg.uid, dateTS, msg.flags);
        }
      }

      syncState.sinceDate = newSinceDate.valueOf();
      // Do we not have a lastHighUid (because this is our first grow for the
      // folder?)
      if (!syncState.lastHighUid) {
        // Use the UIDNEXT if the server provides it (some are jerks and don't)
        if (mailboxInfo.uidNext) {
          syncState.lastHighUid = mailboxInfo.uidNext - 1;
        }
        // Okay, then try and find the max of all the UIDs we heard about.
        else if (uids.length) {
          // Use logical or in case a NaN somehow got in there for paranoia
          // reasons.
          syncState.lastHighUid = Math.max(...uids) || 0;
        }
        // Oh, huh, no UIDNEXT and no messages found?  Well, just pick 1 if
        // there are some messages but not a huge number.
        // XXX this is horrid; the full-folder fast sync and statistical date
        // choices above should make us be able to avoid this.
        else if (mailboxInfo.exists && mailboxInfo.exists < 100) {
          syncState.lastHighUid = 1;
        }
      }

      return {
        mutations: {
          syncStates: new Map([[req.folderId, syncState.rawSyncState]]),
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
                fullySynced: syncState.sinceDate === OLDEST_SYNC_DATE.valueOf(),
                estimatedUnsyncedMessages,
                syncedThrough: syncState.sinceDate,
                lastSuccessfulSyncAt: syncDate,
                lastAttemptedSyncAt: syncDate,
                failedSyncsSinceLastSuccessfulSync: 0,
              }
            ]])
        }
      };
    }
  }
]);


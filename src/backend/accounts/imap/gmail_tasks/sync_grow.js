import logic from 'logic';

import { shallowClone } from 'shared/util';

import TaskDefiner from '../../../task_infra/task_definer';

import { quantizeDate, NOW } from 'shared/date';

import * as imapchew from '../imapchew';
const parseImapDateTime = imapchew.parseImapDateTime;

import { parseUI64 as parseGmailConvId } from 'shared/a64';

import GmailLabelMapper from '../gmail/gmail_label_mapper';
import SyncStateHelper from '../gmail/sync_state_helper';

import { OLDEST_SYNC_DATE, SYNC_WHOLE_FOLDER_AT_N_MESSAGES,
        GROWTH_MESSAGE_COUNT_TARGET } from '../../../syncbase';

import { syncNormalOverlay } from
  '../../../task_helpers/sync_overlay_helpers';

import MixinImapProbeForDate from '../task_mixins/imap_mix_probe_for_date';

/**
 * Expand the date-range of known messages for the given folder/label.
 * See sync.md for detailed documentation on our algorithm/strategy.
 */
export default TaskDefiner.defineAtMostOnceTask([
  MixinImapProbeForDate,
  {
    name: 'sync_grow',
    // Note that we are tracking grow status on folders while we track refresh
    // status on the account as a whole.
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
      // -- Exclusively acquire the sync state for the account
      let fromDb = await ctx.beginMutate({
        syncStates: new Map([[req.accountId, null]])
      });

      let syncState = new SyncStateHelper(
        ctx, fromDb.syncStates.get(req.accountId), req.accountId, 'grow');

      let foldersTOC =
        await ctx.universe.acquireAccountFoldersTOC(ctx, req.accountId);
      let labelMapper = new GmailLabelMapper(ctx, foldersTOC);

      // - sync_folder_list dependency-failsafe
      if (foldersTOC.items.length <= 3) {
        // Sync won't work right if we have no folders.  This should ideally be
        // handled by priorities and other bootstrap logic, but for now, just
        // make sure we avoid going into this sync in a broken way.
        throw new Error('moot');
      }

      // -- Enter the label's folder for estimate and heuristic purposes
      let account = await ctx.universe.acquireAccount(ctx, req.accountId);
      let folderInfo = account.getFolderById(req.folderId);
      // Failsafe: In the event the folder has no corresponding server path
      // (which is the case for labels here in the gmail case too), bail by
      // returning an empty result.
      if (!folderInfo.serverPath) {
        return {};
      }
      let labelMailboxInfo = await account.pimap.selectMailbox(ctx, folderInfo);

      // Unlike vanilla IMAP, our sync state does not track exactly how many
      // messages are known to be in each folder.  As things are currently
      // implemented, we unfortunately could since we do lock our sync state
      // more often than we want to.  However, with the introduction of
      // sub-tasks, it makes it possible for us to only acquire the sync-state
      // as needed on sync_conv, so that's the opposite direction we want to go.
      // (Also, we might be able to have sync_conv implement some scatter-write
      // that sync_refresh could slurp up when it next runs.)
      //
      // However, we maintain a trigger-based count of the locally known
      // messages in each folder.
      let estimatedUnsyncedMessages =
        labelMailboxInfo.exists - folderInfo.localMessageCount;

      // NB: Gmail auto-expunges by default, but it can be turned off.  Which is
      // an annoying possibility.
      let searchSpec = { not: { deleted: true } };

      searchSpec['X-GM-LABELS'] = labelMapper.folderIdToLabel(req.folderId);

      let existingSinceDate = syncState.getFolderIdSinceDate(req.folderId);
      let newSinceDate;
      let firstInboxSync = !existingSinceDate && folderInfo.type === 'inbox';

      // If there are fewer messages left to sync than our constant for this
      // purpose, then just set the date range to our oldest sync date.
      if (!isNaN(estimatedUnsyncedMessages) &&
          estimatedUnsyncedMessages < Math.max(SYNC_WHOLE_FOLDER_AT_N_MESSAGES,
                                             GROWTH_MESSAGE_COUNT_TARGET)) {
        newSinceDate = OLDEST_SYNC_DATE;
      } else {
        newSinceDate = await this._probeForDateUsingSequenceNumbers({
          ctx, account, folderInfo,
          startSeq: labelMailboxInfo.exists - folderInfo.localMessageCount,
          curDate: existingSinceDate || quantizeDate(NOW())
        });
      }

      if (existingSinceDate) {
       searchSpec.before = new Date(quantizeDate(existingSinceDate));
      }
      searchSpec.since = new Date(newSinceDate);

      let syncDate = NOW();

      logic(ctx, 'searching', { searchSpec: searchSpec });
      let allMailFolderInfo = account.getFirstFolderWithType('all');
      // Find out new UIDs covering the range in question.
      let { mailboxInfo, result: uids } = await account.pimap.search(
        ctx, allMailFolderInfo, searchSpec, { byUid: true });

      if (uids.length) {
        let { result: messages } = await account.pimap.listMessages(
          ctx,
          allMailFolderInfo,
          uids,
          [
            'UID',
            'INTERNALDATE',
            'X-GM-THRID',
          ],
          { byUid: true }
        );

        for (let msg of messages) {
          let uid = msg.uid; // already parsed into a number by browserbox
          let dateTS = parseImapDateTime(msg.internaldate);
          let rawConvId = parseGmailConvId(msg['x-gm-thrid']);

          if (syncState.yayUids.has(uid)) {
            // Nothing to do if the message already met our criteria.  (And we
            // don't care about the flags because they're already up-to-date,
            // inductively.)
          } else if (syncState.mehUids.has(uid)) {
            // The message is now a yay message, hooray!
            syncState.existingMehMessageIsNowYay(uid, rawConvId, dateTS);
          } else {
            // Inductively, this is a newly yay message and potentially the
            // start of a new yay conversation.
            syncState.existingIgnoredMessageIsNowYay(
              uid, rawConvId, dateTS);
          }
        }
      }

      syncState.setFolderIdSinceDate(req.folderId, newSinceDate.valueOf());
      logic(ctx, 'mailboxInfo', { existingModseq: syncState.modseq,
        newModseq: mailboxInfo.highestModseq, _mailboxInfo: mailboxInfo });
      if (!syncState.modseq) {
        syncState.modseq = mailboxInfo.highestModseq;
        syncState.lastHighUid = mailboxInfo.uidNext - 1;
        logic(ctx, 'updatingModSeq', { modseqNow: syncState.modseq,
         from: mailboxInfo.highestModseq});
      }
      syncState.finalizePendingRemovals();

      let atomicClobbers = {};
      // Treat our first inbox sync as a full sync.  This is true for gaia mail,
      // this is potentially less true for other UIs, but it's true enough.
      if (firstInboxSync) {
        atomicClobbers = {
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
        };
      }

      atomicClobbers.folders = new Map([
        [
          req.folderId,
          {
            fullySynced: newSinceDate.valueOf() === OLDEST_SYNC_DATE.valueOf(),
            estimatedUnsyncedMessages,
            syncedThrough: newSinceDate.valueOf()
          }
        ]
      ]);

      return {
        mutations: {
          syncStates: new Map([[req.accountId, syncState.rawSyncState]]),
        },
        newData: {
          tasks: syncState.tasksToSchedule
        },
        atomicClobbers
      };
    }
  }
]);

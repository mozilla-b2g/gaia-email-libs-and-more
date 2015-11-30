define(function(require) {
'use strict';

let co = require('co');
let logic = require('logic');

let TaskDefiner = require('../../task_infra/task_definer');

let { makeDaysBefore, quantizeDate, NOW, DAY_MILLIS } = require('../../date');

let imapchew = require('../imapchew');
let parseImapDateTime = imapchew.parseImapDateTime;


let FolderSyncStateHelper = require('../vanilla/folder_sync_state_helper');

const { INITIAL_SYNC_GROWTH_DAYS, OLDEST_SYNC_DATE,
        SYNC_WHOLE_FOLDER_AT_N_MESSAGES, GROWTH_MESSAGE_COUNT_TARGET } =
  require('../../syncbase');

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
return TaskDefiner.defineSimpleTask([
  {
    name: 'sync_grow',
    args: ['accountId', 'folderId', 'minDays'],

    exclusiveResources: function(args) {
      return [
        // Only one of us/sync_refresh is allowed to be active at a time.
        `sync:${args.accountId}`,
      ];
    },

    priorityTags: function(args) {
      return [
        `view:folder:${args.folderId}`
      ];
    },


    /**
     * Figure out the right date to use for date-based sync by investigating
     * the INTERNALDATEs of messages that we ostensibly have not yet
     * synchronized.  This will err on the side of synchronizing fewer messages.
     *
     * The underlying assumption is that messages with higher sequence numbers
     * are more recent.  While this is generally true, there will also be
     * exceptions due to messages being moved between folders.  We want to
     * avoid being tricked into synchronizing way more messages than desired by
     * the presence of a bunch of recently added (to the folder) OLD messages.
     * We also want to minimize traffic and server burden while being fairly
     * simple.
     *
     * Our approach is to build a list of sequence numbers using an
     * exponentially growing step size, starting with a step size related to
     * our target growth size.  This gives us a number of data points from
     * messages that should be recent, plus a bounded number of points from
     * messages that should be old.  This lets us test our hypothesis that this
     * is a folder where message sequence numbers correlate with recent
     * messages.  If this does not appear to be the case, we are able to fall
     * back to just growing our sync range by a fixed time increment.
     *
     * We do not use UIDs because they have the same correlation but due to
     * numeric gaps and it being an error to explicitly reference a nonexistent
     * UID, it's not a viable option.
     */
    _probeForDateUsingSequenceNumbers: co.wrap(function*({
        ctx, account, folderInfo, startSeq, curDate }) {
      let probeStep = Math.ceil(GROWTH_MESSAGE_COUNT_TARGET / 4);
      // Scale factor for the step size after each step.  This must be an
      // integer or we need to add rounding logic in the loop.
      const PROBE_STEP_SCALE = 2;

      // - Generate the list of message sequences to probe.
      let seqs = [];
      for (let curSeq = startSeq;
           curSeq >= 1;
           curSeq -= probeStep, probeStep *= PROBE_STEP_SCALE) {
        seqs.push(curSeq);
      }

      let { result: messages } = yield account.pimap.listMessages(
        ctx,
        folderInfo,
        seqs,
        [
          'INTERNALDATE',
        ],
        {}
      );

      // sort the messages by descending sequence number so our iteration path
      // should be backwards into time.
      messages.sort((a, b) => {
        return b['#'] - a['#'];
      });

      // In our loop we ratchet the checkDate past-wards as we find older
      // messages.  If we find a newer message as we move backwards, it's a
      // violation and we add the time-difference to our violationsDelta.  We
      // do this rather than just incrementing a violation count because small
      // regions of low-delta homogeneity at the beginning of the range are not
      // a huge problem.  It might make sense to scale this by the sequence
      // number distance, but the goal here is to know when to bail, not create
      // an awesome stastical model.
      let violationsDelta = 0;
      let checkDate = 0;
      for (let msg of messages) {
        let msgDate = parseImapDateTime(msg.internaldate);
        if (!checkDate) {
          checkDate = msgDate;
        } else if (msgDate > checkDate) {
          violationsDelta += msgDate - checkDate;
        } else {
          checkDate = msgDate;
        }
      }

      logic(
        ctx, 'dateProbeResults',
        { violationDays: Math.floor(violationsDelta / DAY_MILLIS) });

      // 100% arbitrary.  But obviously if the folder is 10,000 messages all
      // from the same week, we're screwed no matter what.
      if (violationsDelta > 7 * DAY_MILLIS) {
        // The folder's no good!  We can't do any better than just a fixed
        // time adjustment.
        return makeDaysBefore(curDate, INITIAL_SYNC_GROWTH_DAYS);
      }
      // Woo, the folder is consistent with our assumptions and highly dubious
      // tests!
      return quantizeDate(
        parseImapDateTime(
          messages[Math.min(messages.length - 1, 2)].internaldate));
    }),

    execute: co.wrap(function*(ctx, req) {
      // -- Exclusively acquire the sync state for the folder
      let fromDb = yield ctx.beginMutate({
        syncStates: new Map([[req.folderId, null]])
      });

      let syncState = new FolderSyncStateHelper(
        ctx, fromDb.syncStates.get(req.folderId), req.accountId,
        req.folderId, 'grow');

      // -- Enter the folder to get an estimate of the number of messages
      let account = yield ctx.universe.acquireAccount(ctx, req.accountId);
      let folderInfo = account.getFolderById(req.folderId);
      let mailboxInfo = yield account.pimap.selectMailbox(ctx, folderInfo);

      // Figure out an upper bound on the number of messages in the folder that
      // we have not synchronized.
      let unsyncedMessageEstimate =
        mailboxInfo.exists - syncState.knownMessageCount;

      // -- Issue a search for the new date range we're expanding to cover.
      let searchSpec = { not: { deleted: true } };

      let existingSinceDate = syncState.sinceDate;
      let newSinceDate;

      // If there are fewer messages left to sync than our constant for this
      // purpose, then just set the date range to our oldest sync date.
      if (!isNaN(unsyncedMessageEstimate) &&
          unsyncedMessageEstimate < Math.max(SYNC_WHOLE_FOLDER_AT_N_MESSAGES,
                                             GROWTH_MESSAGE_COUNT_TARGET)) {
        newSinceDate = OLDEST_SYNC_DATE;
      } else {
        newSinceDate = yield this._probeForDateUsingSequenceNumbers({
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
      let { result: uids } = yield account.pimap.search(
        ctx, folderInfo, searchSpec, { byUid: true });

      // -- Fetch flags and the dates for the new messages
      // We want the date so we can prioritize the synchronization of the
      // message.  We want the flags because the sync state needs to persist and
      // track the flags so it can detect changes in flags in sync_refresh.
      if (uids.length) {
        let newUids = syncState.filterOutKnownUids(uids);

        let { result: messages } = yield account.pimap.listMessages(
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

      yield ctx.finishTask({
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
                estimatedUnsyncedMessages:
                  mailboxInfo.exists - syncState.knownMessageCount,
                syncedThrough: syncState.sinceDate,
                lastSuccessfulSyncAt: syncDate,
                lastAttemptedSyncAt: syncDate,
                failedSyncsSinceLastSuccessfulSync: 0,
              }
            ]])
        }
      });
    })
  }
]);
});

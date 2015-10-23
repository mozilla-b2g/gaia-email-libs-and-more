define(function(require) {
'use strict';

const co = require('co');
const logic = require('logic');

const TaskDefiner = require('../../task_infra/task_definer');

const { makeDaysAgo, makeDaysBefore, quantizeDate, NOW } = require('../../date');

const imapchew = require('../imapchew');
const parseImapDateTime = imapchew.parseImapDateTime;

const a64 = require('../../a64');
const parseGmailConvId = a64.parseUI64;


const GmailLabelMapper = require('../gmail/gmail_label_mapper');
const SyncStateHelper = require('../gmail/sync_state_helper');

const syncbase = require('../../syncbase');

/**
 * Expand the date-range of known messages for the given folder/label.
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

    execute: co.wrap(function*(ctx, req) {
      // -- Exclusively acquire the sync state for the account
      let fromDb = yield ctx.beginMutate({
        syncStates: new Map([[req.accountId, null]])
      });

      let syncState = new SyncStateHelper(
        ctx, fromDb.syncStates.get(req.accountId), req.accountId, 'grow');

      let foldersTOC =
        yield ctx.universe.acquireAccountFoldersTOC(ctx, req.accountId);
      let labelMapper = new GmailLabelMapper(foldersTOC);

      // - sync_folder_list dependency-failsafe
      if (foldersTOC.items.length <= 3) {
        // Sync won't work right if we have no folders.  This should ideally be
        // handled by priorities and other bootstrap logic, but for now, just
        // make sure we avoid going into this sync in a broken way.
        throw new Error('moot');
      }

      // NB: Gmail auto-expunges by default, but it can be turned off.  Which is
      // an annoying possibility.
      let searchSpec = { not: { deleted: true } };

      searchSpec['X-GM-LABELS'] = labelMapper.folderIdToLabel(req.folderId);

      let existingSinceDate = syncState.getFolderIdSinceDate(req.folderId);
      let newSinceDate;
      let firstInboxSync = false;
      if (existingSinceDate) {
        searchSpec.before = new Date(quantizeDate(existingSinceDate));
        newSinceDate = makeDaysBefore(existingSinceDate,
                                      syncbase.INITIAL_SYNC_GROWTH_DAYS);
        searchSpec.since = new Date(newSinceDate);
      } else {
        // It's the first sync for this folder, but is this folder the inbox?
        firstInboxSync =
          foldersTOC.foldersById.get(req.folderId).type === 'inbox';
        newSinceDate = makeDaysAgo(syncbase.INITIAL_SYNC_DAYS);
        searchSpec.since = new Date(newSinceDate);
      }

      let account = yield ctx.universe.acquireAccount(ctx, req.accountId);

      let syncDate = NOW();

      logic(ctx, 'searching', { searchSpec: searchSpec });
      let allMailFolderInfo = account.getFirstFolderWithType('all');
      // Find out new UIDs covering the range in question.
      let { mailboxInfo, result: uids } = yield account.pimap.search(
        allMailFolderInfo, searchSpec, { byUid: true });

      if (uids.length) {
        let { result: messages } = yield account.pimap.listMessages(
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
        newModseq: mailboxInfo.highestModseq, mailboxInfo: mailboxInfo });
      if (!syncState.modseq) {
        syncState.modseq = mailboxInfo.highestModseq;
        syncState.lastHighUid = mailboxInfo.uidNext - 1;
        logic(ctx, 'updatingModSeq', { modseqNow: syncState.modseq,
         from: mailboxInfo.highestModseq});
      }
      syncState.finalizePendingRemovals();

      let atomicClobbers;
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

      yield ctx.finishTask({
        mutations: {
          syncStates: new Map([[req.accountId, syncState.rawSyncState]]),
        },
        newData: {
          tasks: syncState.tasksToSchedule
        },
        atomicClobbers
      });
    })
  }
]);
});

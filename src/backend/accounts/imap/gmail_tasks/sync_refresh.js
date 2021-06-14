import logic from 'logic';

import { shallowClone } from 'shared/util';

import { NOW } from 'shared/date';

import TaskDefiner from '../../../task_infra/task_definer';

import GmailLabelMapper from '../gmail/gmail_label_mapper';
import SyncStateHelper from '../gmail/sync_state_helper';

import * as imapchew from '../imapchew';
const parseImapDateTime = imapchew.parseImapDateTime;

import { parseUI64 as parseGmailConvId, parseUI64 as parseGmailMsgId } from 'shared/a64';

import { accountIdFromFolderId } from 'shared/id_conversions';

import { syncNormalOverlay, syncPrefixOverlay } from
  '../../../task_helpers/sync_overlay_helpers';

/**
 * This is the steady-state sync task that drives all of our gmail sync.
 * See sync.md for detailed documentation on our algorithm/strategy.
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

    helped_invalidate_overlays(accountId, dataOverlayManager) {
      dataOverlayManager.announceUpdatedOverlayData(
        'accounts', accountId);
      dataOverlayManager.announceUpdatedOverlayData(
        'accountCascadeToFolders', accountId);
    },

    helped_already_planned(ctx, rawTask) {
      // The group should already exist; opt into its membership to get a
      // Promise
      return Promise.resolve({
        result: ctx.trackMeInTaskGroup('sync_refresh:' + rawTask.accountId)
      });
    },

    /**
     * In our planning phase we discard nonsensical requests to refresh
     * local-only folders.
     */
    helped_plan(ctx, rawTask) {
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

      // -- Check to see if we need to spin-off the first-ever sync_grow
      if (!rawSyncState) {
        return {
          // we ourselves are done
          taskState: null,
          newData: {
            tasks: [
              {
                type: 'sync_grow',
                accountId: req.accountId,
                folderId: req.folderId
              }
            ]
          }
        };
      }
      let syncState = new SyncStateHelper(ctx, rawSyncState, req.accountId,
                                          'refresh');

      if (!syncState.modseq) {
        // This is inductively possible, and it's a ridiculously serious problem
        // for us if we issue a FETCH 1:* against the entirety of the All Mail
        // folder.
        throw new Error('missing modseq');
      }

      // -- Check to see if this is the first sync for this folder
      // (The above check was the first check ever for anyone.)
      if (!syncState.getFolderIdSinceDate(req.folderId)) {
        return {
          // we ourselves are done
          taskState: null,
          newData: {
            tasks: [
              {
                type: 'sync_grow',
                accountId: req.accountId,
                folderId: req.folderId
              }
            ]
          }
        };
      }

      // -- Okay, we're going to go through with this sync directly
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


      let account = await ctx.universe.acquireAccount(ctx, req.accountId);
      let allMailFolderInfo = account.getFirstFolderWithType('all');

      let syncDate = NOW();

      logic(ctx, 'syncStart', { modseq: syncState.modseq });
      let { mailboxInfo, result: messages } = await account.pimap.listMessages(
        ctx,
        allMailFolderInfo,
        '1:*',
        [
          'UID',
          'INTERNALDATE',
          'X-GM-THRID',
          'X-GM-LABELS',
          // We don't need/want FLAGS for new messsages (ones with a higher UID
          // than we've seen before), but it's potentially kinder to gmail to
          // ask for everything in a single go.
          'FLAGS',
          // Same deal for the X-GM-MSGID.  We are able to do a more efficient
          // db access pattern if we have it, but it's not really useful in the
          // new conversation/new message case.
          'X-GM-MSGID'
        ],
        {
          byUid: true,
          changedSince: syncState.modseq
        }
      );

      // To avoid getting redundant information in the future, we need to know
      // the effective modseq of this fetch request.  Because we don't
      // necessarily re-enter the folder above and there's nothing saying that
      // the apparent MODSEQ can only change on entry, we must consider the
      // MODSEQs of the results we are provided.
      let highestModseq = a64.maxDecimal64Strings(
        mailboxInfo.highestModseq, syncState.modseq);
      for (let msg of messages) {
        let uid = msg.uid; // already parsed into a number by browserbox
        let dateTS = parseImapDateTime(msg.internaldate);
        let rawConvId = parseGmailConvId(msg['x-gm-thrid']);
        // Unwrap the imap-parser tagged { type, value } objects.  (If this
        // were a singular value that wasn't a list it would automatically be
        // unwrapped.)
        let rawLabels = msg['x-gm-labels'];
        let flags = msg.flags;

        highestModseq = a64.maxDecimal64Strings(highestModseq, msg.modseq);

        // Have store_labels apply any (offline) requests that have not yet been
        // replayed to the server.
        ctx.synchronouslyConsultOtherTask(
          { name: 'store_labels', accountId: req.accountId },
          { uid: uid, value: rawLabels });
        // same with store_flags
        ctx.synchronouslyConsultOtherTask(
          { name: 'store_flags', accountId: req.accountId },
          { uid: uid, value: flags });

        let labelFolderIds = labelMapper.labelsToFolderIds(rawLabels);

        // Is this a new message?
        if (uid > syncState.lastHighUid) {
          // Does this message meet our sync criteria on its own?
          if (syncState.messageMeetsSyncCriteria(dateTS, labelFolderIds)) {
            // (Yes, it's a yay message.)
            // Is this a conversation we already know about?
            if (syncState.isKnownRawConvId(rawConvId)) {
              syncState.newYayMessageInExistingConv(
                uid, rawConvId, dateTS);
            } else { // no, it's a new conversation to us!
              syncState.newYayMessageInNewConv(uid, rawConvId, dateTS);
            }
          // Okay, it didn't meet it on its own, but does it belong to a
          // conversation we care about?
          } else if (syncState.isKnownRawConvId(rawConvId)) {
            syncState.newMehMessageInExistingConv(uid, rawConvId, dateTS);
          } else { // We don't care.
            syncState.newMootMessage(uid);
          }
        } else { // It's an existing message
          let newState = {
            rawMsgId: parseGmailMsgId(msg['x-gm-msgid']),
            flags,
            labels: labelFolderIds
          };
          if (syncState.messageMeetsSyncCriteria(dateTS, labelFolderIds)) {
            // it's currently a yay message, but was it always a yay message?
            if (syncState.yayUids.has(uid)) {
              // yes, forever awesome.
              syncState.existingMessageUpdated(
                uid, rawConvId, dateTS, newState);
            } else if (syncState.mehUids.has(uid)) {
              // no, it was meh, but is now suddenly fabulous
              syncState.existingMehMessageIsNowYay(
                uid, rawConvId, dateTS, newState);
            } else {
              // Not aware of the message, so inductively this conversation is
              // new to us.
              syncState.existingIgnoredMessageIsNowYayInNewConv(
                uid, rawConvId, dateTS);
            }
          // Okay, so not currently a yay message, but was it before?
          } else if (syncState.yayUids.has(uid)) {
            // it was yay, is now meh, this potentially even means we no longer
            // care about the conversation at all
            syncState.existingYayMessageIsNowMeh(
              uid, rawConvId, dateTS);
          } else if (syncState.mehUids.has(uid)) {
            // it was meh, it's still meh, it's just an update
            syncState.existingMessageUpdated(
              uid, rawConvId, dateTS, newState);
          } else {
            syncState.existingMootMessage(uid);
          }
        }
      }

      syncState.lastHighUid = mailboxInfo.uidNext - 1;
      syncState.modseq = highestModseq;
      syncState.finalizePendingRemovals();
      logic(ctx, 'syncEnd', { modseq: syncState.modseq });

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

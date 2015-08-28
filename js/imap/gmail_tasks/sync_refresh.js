define(function(require) {
'use strict';

let co = require('co');
let logic = require('logic');

let TaskDefiner = require('../../task_definer');

let GmailLabelMapper = require('../gmail/gmail_label_mapper');
let SyncStateHelper = require('../gmail/sync_state_helper');

let imapchew = require('../imapchew');
let parseImapDateTime = imapchew.parseImapDateTime;

let a64 = require('../../a64');
let parseGmailConvId = a64.parseUI64;
let parseGmailMsgId = a64.parseUI64;


/**
 * This is the steady-state sync task that drives all of our gmail sync.
 */
return TaskDefiner.defineSimpleTask([
  {
    name: 'sync_refresh',
    // The folderId is an optional focal folder of interest.  This matters for
    // the base-case where we've never synchronized the folder intentionally,
    // and so a sync_grow is the appropriate course of action.
    args: ['accountId', 'folderId'],

    exclusiveResources: function(args) {
      return [
        // Only one of us/sync_grow is allowed to be active at a time.
        `sync:${args.accountId}`
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
      let rawSyncState = fromDb.syncStates.get(req.accountId);

      // -- Check to see if we need to spin-off a sync_grow instead
      if (!rawSyncState) {
        yield ctx.finishTask({
          // we ourselves are done
          taskState: null,
          newData: {
            tasks: [
              {
                type: 'sync_grow',
                accountId: req.accountId,
                // This is reliably the inbox, but this is probably not the
                // right way to do this...
                folderId: req.accountId + '.0'
              }
            ]
          }
        });
        return;
      }
      let syncState = new SyncStateHelper(ctx, rawSyncState, req.accountId,
                                          'refresh');

      if (!syncState.modseq) {
        // This is inductively possible, and it's a ridiculously serious problem
        // for us if we issue a FETCH 1:* against the entirety of the All Mail
        // folder.
        throw new Error('missing modseq');
      }

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

      let account = yield ctx.universe.acquireAccount(ctx, req.accountId);
      let allMailFolderInfo = account.getFirstFolderWithType('all');

      logic(ctx, 'syncStart', { modseq: syncState.modseq });
      let { mailboxInfo, result: messages } = yield account.pimap.listMessages(
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
        let rawLabels = msg['x-gm-labels'].map(x => x.value);
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

      yield ctx.finishTask({
        mutations: {
          syncStates: new Map([[req.accountId, syncState.rawSyncState]]),
        },
        newData: {
          tasks: syncState.tasksToSchedule
        }
      });
    })
  }
]);
});

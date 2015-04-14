define(function(require) {

let TaskDefiner = require('../../task_definer');

let GmailLabelMapper = require('../gmail_label_mapper');
let SyncStateHelper = require('../sync_state_helper');

let imapchew = require('../imapchew');
let parseImapDateTime = imapchew.parseImapDateTime;



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

    exclusiveResources: [
      // Only one of us/sync_grow is allowed to be active at a time.
      (args) => `sync:${args.accountId}`,
    ],

    execute: function*(ctx, req) {
      // -- Exclusively acquire the sync state for the account
      // XXX duplicated boilerplate from sync_grow; prettify/normalize
      let syncReqMap = new Map();
      syncReqMap.set(req.accountId, null);
      yield ctx.beginMutate({
        syncStates: syncReqMap
      });
      let rawSyncState = syncReqMap.get(req.accountId);

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

      let foldersTOC =
        yield ctx.universe.acquireAccountFoldersTOC(req.accountId);
      let labelMapper = new GmailLabelMapper(foldersTOC);

      let syncState = new SyncStateHelper(ctx, rawSyncState, req.accountId);

// UID INTERNALDATE X-GM-LABELS X-GMTHRID FLAGS

      let { mailboxInfo, messages } = yield ctx.pimap.listMessages(
        req.folderId,
        uids,
        [
          'UID',
          'INTERNALDATE',
          'X-GM-THRID',
          'X-GM-LABELS',
          // We don't need/want FLAGS for new messsages (ones with a higher UID
          // than we've seen before), but it's potentially kinder to gmail to
          // ask for everything in a single go.
          'FLAGS'
        ],
        {
          byUid: true,
          changedSince: syncState.modseq
        }
      );

      for (let msg of messages) {
        let uid = msg.uid; // already parsed into a number by browserbox
        let dateTS = parseImapDateTime(msg.internaldate);
        let rawConvId = parseGmailConvId(msg['x-gm-thrid']);
        let labelFolderIds = labelMapper.labelsToFolderIds(msg['x-gm-labels']);

        // Is this a new message?
        if (uid > lastHighUid) {
          // Does this message meet our sync criteria on its own?
          if (syncState.messageMeetsSyncCriteria(date, labelFolderIds)) {
            // (Yes, it's a yay message.)
            // Is this a conversation we already know about?
            if (syncState.isKnownConversation(rawConvId)) {
              syncState.trackNewYayMessageInExistingConv(
                uid, rawConvId, dateTS);
            } else { // no, it's a new conversation to us!
              syncState.trackNewYayMessageInNewConv(uid, rawConvId, dateTS);
            }
          }
        } else { // It's an existing message

        }



        tasks.push({
          name: 'sync_conv',
        });
      }

      yield ctx.finishTask({

      })
    }
  }
]);
});

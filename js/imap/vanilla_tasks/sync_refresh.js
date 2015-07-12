define(function(require) {
'use strict';

let co = require('co');

let TaskDefiner = require('../../task_definer');

let FolderSyncStateHelper = require('../vanilla/folder_sync_state_helper');


let imapchew = require('../imapchew');
let parseImapDateTime = imapchew.parseImapDateTime;


/**
 * This is the steady-state sync task that drives all of our gmail sync.
 */
return TaskDefiner.defineSimpleTask([
  {
    name: 'sync_refresh',
    args: ['accountId', 'folderId'],

    exclusiveResources: function(args) {
      return [
        `sync:${args.folderId}`
      ];
    },

    priorityTags: function(args) {
      return [
        `view:folder:${args.folderId}`
      ];
    },

    execute: co.wrap(function*(ctx, req) {
      // -- Exclusively acquire the sync state for the folder
      let fromDb = yield ctx.beginMutate({
        syncStates: new Map([[req.folderId, null]])
      });

      let rawSyncState = fromDb.syncStates.get(req.folderId);

      // -- Check to see if we need to spin-off a sync_grow instead
      // We need to do this if we don't have any sync state or if we do have
      // sync state but we don't have a high uid.
      if (!rawSyncState || !rawSyncState.lastHighUid) {
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

      let syncState = new FolderSyncStateHelper(
        ctx, rawSyncState, req.accountId, req.folderId, 'refresh');

      // -- Parallel 1/2: Issue find new messages
      let account = yield ctx.universe.acquireAccount(ctx, req.accountId);
      let folderInfo = account.getFolderMetaForFolderId(req.folderId);

      let parallelNewMessages = account.pimap.listMessages(
        folderInfo,
        syncState.lastHighUid + ':*',
        [
          'UID',
          'INTERNALDATE',
          'FLAGS'
        ],
        {
          byUid: true,
          changedSince: syncState.modseq
        }
      );

      // -- Parallel 2/2: Find deleted messages and look for flag changes.
      // - Do a UID SEARCH UID against the set of UIDs we know about
      // This lets us infer deletion.  In v1 we would have re-performed our
      // time-based SEARCH and done a delta-check on the UIDs, but that was not
      // capable of dealing with sparse messages due to search-on-server and
      // conversation back-filling.  (Well, without additional inference logic
      // for dealing with the sparse ranges.)
      //
      // From an efficiency perspective we're optimizing to avoid the worst-case
      // scenario of having the server tell us about significantly more UIDs
      // than we care about versus a search that over-reports.  And of course
      // we're saving even more bandwidth versus a FETCH of all flags which
      // would also allow deletion inference.  We're not particularly concerned
      // about the server costs here; we plan to support QRESYNC ASAP and any
      // server that doesn't implment QRESYNC really only has itself to blame.
      let searchSpec = {
        not: { deleted: true },
        // NB: deletion-wise, one might ask whether we should be consulting the
        // trash task here so that we can pretend like the message does not
        // exist.  The answer is no.  Because in the event we decide to un-trash
        // a message we would like to already have the flags up-to-date.  (This
        // matters more for CONDSTORE/QRESYNC where we only get info on-change
        // versus this dumb implementation where we infer that ourselves.)
        uid: syncState.getAllUids()
      };
      let { result: searchedUids } = yield account.pimap.search(
        folderInfo, searchSpec, { byUid: true });
      syncState.inferDeletionFromExistingUids(searchedUids);

      // - Do envelope fetches on the non-deleted messages
      let { result: currentFlagMessages } = account.pimap.listMessages(
        folderInfo,
        syncState.lastHighUid + ':*',
        [
          'UID',
          'FLAGS'
        ],
        {
          byUid: true,
        }
      );
      for (let msg of currentFlagMessages) {
        let flags = msg.flags;
        // Have the flag-setting task fix-up the flags to compensate for any
        // changes we haven't played against the server.
        // TODO: get smarter in the future to avoid redundantly triggering a
        // sync_conv task that just re-asserts the already locally-applied
        // changes.
        ctx.synchronouslyConsultOtherTask(
          { name: 'store_flags', accountId: req.accountId },
          { uid: msg.uid, value: flags });
        syncState.checkFlagChanges(msg.uid, msg.flags);
      }

      // -- Parallel 1/2: Process new messsages
      let highestUid = syncState.lastHighUid;
      let { result: newMessages } = yield parallelNewMessages;
      for (let msg of newMessages) {
        let dateTS = parseImapDateTime(msg.internaldate);
        highestUid = Math.max(highestUid, msg.uid);
        if (syncState.messageMeetsSyncCriteria(dateTS)) {
          syncState.yayMessageFoundByDate(msg.uid, dateTS, msg.flags);
        }
      }

      // -- Issue name reads if needed.
      if (syncState.umidNameReads.size) {
        yield ctx.read({
          umidNames: umidNameReads // mutated as a side-effect.
        });
        syncState.generateSyncConvTasks();
      }

      syncState.lastHighUid = highestUid;

      yield ctx.finishTask({
        mutations: {
          syncStates: new Map([[req.folderId, syncState.rawSyncState]]),
        },
        newData: {
          tasks: syncState.tasksToSchedule
        }
      });
    })
  }
]);
});

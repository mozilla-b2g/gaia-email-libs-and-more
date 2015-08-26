define(function(require) {
'use strict';

let co = require('co');
let { shallowClone } = require('../../util');

let TaskDefiner = require('../../task_definer');

let FolderSyncStateHelper = require('../vanilla/folder_sync_state_helper');


let imapchew = require('../imapchew');
let parseImapDateTime = imapchew.parseImapDateTime;


/**
 * Steady state vanilla IMAP folder sync.
 */
return TaskDefiner.defineSimpleTask([
  {
    name: 'sync_refresh',
    args: ['accountId', 'folderId'],

    /**
     * In our planning phase we discard nonsensical requests to refresh
     * local-only folders.
     */
    plan: co.wrap(function*(ctx, rawTask) {
      // Get the folder
      let foldersTOC =
        yield ctx.universe.acquireAccountFoldersTOC(ctx, ctx.accountId);
      let folderInfo = foldersTOC.foldersById.get(rawTask.folderId);

      // - Only plan if the folder is real AKA it has a path.
      // (We could also look at its type.  Or have additional explicit state.
      // Checking the path is fine and likely future-proof.  The only real new
      // edge case we would expect is offline folder creation.  But in that
      // case we still wouldn't want refreshes triggered before we've created
      // the folder and populated it.)
      let plannedTask;
      if (!folderInfo.serverPath) {
        plannedTask = null;
      } else {
        plannedTask = shallowClone(rawTask);
        plannedTask.exclusiveResources = [
          `sync:${rawTask.folderId}`
        ];
        plannedTask.priorityTags = [
          `view:folder:${rawTask.folderId}`
        ];
      }

      yield ctx.finishTask({
        taskState: plannedTask
      });
    }),

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
                folderId: req.folderId
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
      let folderInfo = account.getFolderById(req.folderId);

      // XXX fastpath out if UIDNEXT says there's nothing new.
      // For Yahoo at least, if there are no new messages, so we're asking
      // for a UID that doesn't exist, it ends up pretending like we said the
      // number of the highest UID.  Oh. Hm.  Could it be the "*" that causes
      // the range to be N+1:N ?  Maybe that's it.  Anyways, be smarter by
      // adding a step that selects the folder first and checks UIDNEXT.
      let parallelNewMessages = account.pimap.listMessages(
        folderInfo,
        (syncState.lastHighUid + 1) + ':*',
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
        // XXX have range-generation logic
        uid: syncState.getAllUids().join(',')
      };
      let { result: searchedUids } = yield account.pimap.search(
        folderInfo, searchSpec, { byUid: true });
      syncState.inferDeletionFromExistingUids(searchedUids);

      // - Do envelope fetches on the non-deleted messages
      // XXX use SEARCHRES here when possible!
      let { result: currentFlagMessages } = yield account.pimap.listMessages(
        folderInfo,
        searchedUids.join(','),
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
        let umid = syncState.getUmidForUid(msg.uid);
        // Have the flag-setting task fix-up the flags to compensate for any
        // changes we haven't played against the server.
        // TODO: get smarter in the future to avoid redundantly triggering a
        // sync_conv task that just re-asserts the already locally-applied
        // changes.
        if (umid) {
          ctx.synchronouslyConsultOtherTask(
            { name: 'store_flags', accountId: req.accountId },
            { uid: msg.uid, value: flags });
        }
        syncState.checkFlagChanges(msg.uid, msg.flags);
      }

      // -- Parallel 1/2: Process new messsages
      // NB: This processing must occur after the inferDeletionFromExistingUids
      // calls because otherwise we would infer the deletion of all the new
      // messages we find!
      let highestUid = syncState.lastHighUid;
      let { result: newMessages } = yield parallelNewMessages;
      for (let msg of newMessages) {
        // We want to filter out already known UIDs.  As an edge case we can end
        // up hearing about the highest message again.  But additionally it's
        // possible we might have backfilled to find out about a message before
        // we get around to sync_refresh.
        if (syncState.isKnownUid(msg.uid)) {
          continue;
        }

        let dateTS = parseImapDateTime(msg.internaldate);
        highestUid = Math.max(highestUid, msg.uid);
        if (syncState.messageMeetsSyncCriteria(dateTS)) {
          syncState.yayMessageFoundByDate(msg.uid, dateTS, msg.flags);
        }
      }

      // -- Issue name reads if needed.
      if (syncState.umidNameReads.size) {
        yield ctx.read({
          umidNames: syncState.umidNameReads // mutated as a side-effect.
        });
        syncState.generateSyncConvTasks();
      }

      syncState.lastHighUid = highestUid;

      yield ctx.finishTask({
        mutations: {
          syncStates: new Map([[req.folderId, syncState.rawSyncState]]),
          umidLocations: syncState.umidLocationWrites
        },
        newData: {
          tasks: syncState.tasksToSchedule
        }
      });
    })
  }
]);
});

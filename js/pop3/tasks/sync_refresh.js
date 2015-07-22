define(function(require) {
'use strict';

let co = require('co');

let TaskDefiner = require('../../task_definer');

let SyncStateHelper = require('../sync_state_helper');

const { POP3_MAX_MESSAGES_PER_SYNC } = require('../../syncbase');

/**
 * Steady state vanilla IMAP folder sync.
 */
return TaskDefiner.defineSimpleTask([
  {
    name: 'sync_refresh',
    // folderId-wise, there's basically only the inbox, but we do potentially
    // want this to ignore requests to sync the localdrafts folder, etc.
    args: ['accountId', 'folderId'],

    exclusiveResources: function(args) {
      return [
        `sync:${args.accountId}`
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
        syncStates: new Map([[req.accountId, null]])
      });
      let rawSyncState = fromDb.syncStates.get(req.accountId);
      let syncState = new SyncStateHelper(
        ctx, rawSyncState, req.accountId, 'refresh',
        POP3_MAX_MESSAGES_PER_SYNC);

      // -- Establish the connection
      let account = yield ctx.universe.acquireAccount(ctx, req.accountId);
      let popAccount = account.popAccount;

      let conn = yield popAccount.ensureConnection();

      // -- Infer the UIDLs that are new to us and bin for sync and overflow.
      // Potential enhancement: loadMessageList combines UIDL and LIST.  Our
      // size needs are on-demand enough that we could only issue one-off LIST
      // requests.
      let allMessages = yield conn.loadMessageList();

      syncState.deltaCheckUidls(allMessages);

      yield ctx.finishTask({
        mutations: {
          syncStates: new Map([[req.accountId, syncState.rawSyncState]]),
          umidNames: syncState.umidNameWrites,
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

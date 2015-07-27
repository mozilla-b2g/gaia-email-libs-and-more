define(function(require) {
'use strict';

let co = require('co');

let TaskDefiner = require('../../task_definer');

let SyncStateHelper = require('../sync_state_helper');

const { POP3_MAX_MESSAGES_PER_SYNC } = require('../../syncbase');

/**
 * Sync some messages out of the the overflow set.
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
      // We don't actually need this right now because we're not doing deletion
      // inference against the set of messages we're growing to include.  But
      // we ideally would do that.  And it makes sense to prime the connection
      // while we're in here.
      // TODO: deletion inference here (rather than relying on refresh and
      // error handling in sync_message to handle things.)
      let account = yield ctx.universe.acquireAccount(ctx, req.accountId);
      let popAccount = account.popAccount;

      // as per the above, we're intentionally doing this just for side-effects.
      yield popAccount.ensureConnection();

      syncState.syncOverflowMessages(POP3_MAX_MESSAGES_PER_SYNC);

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

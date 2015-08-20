define(function(require) {
'use strict';

const co = require('co');
const evt = require('evt');
const logic = require('logic');

const TaskDefiner = require('../../task_definer');

const FolderSyncStateHelper = require('../folder_sync_state_helper');

const getFolderSyncKey = require('../smotocol/get_folder_sync_key');
const inferFilterType = require('../smotocol/infer_filter_type');
const enumerateFolderChanges = require('../smotocol/enum_folder_changes');

const { convIdFromMessageId, messageIdComponentFromUmid } =
  require('../../id_conversions');

const churnConversation = require('../../churn_drivers/conv_churn_driver');

const { SYNC_WHOLE_FOLDER_AT_N_MESSAGES } = require('../../syncbase');


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
      let syncState = new FolderSyncStateHelper(
        ctx, rawSyncState, req.accountId, req.folderId, 'refresh');

      let account = yield ctx.universe.acquireAccount(ctx, req.accountId);
      let conn = yield account.ensureConnection();

      let folderInfo = account.getFolderById(req.folderId);

      // -- Construct an emitter with our processing logic
      let emitter = new evt.Emitter();
      let newConversations = [];
      let newMessages = [];

      // The id issuing logic is a fundamental part of the 'add'ed message
      // processing.
      let issueIds = () => {
        let umid = syncState.issueUniqueMessageId();
        let convId = req.accountId + '.' + messageIdComponentFromUmid(umid);
        let messageId = convId + '.' + messageIdComponentFromUmid(umid);
        return { messageId, umid, folderId: req.folderId };
      };
      emitter.on('add', (serverMessageId, message) => {
        syncState.newMessage(serverMessageId, message);

        let convId = convIdFromMessageId(message.id);
        newMessages.push(message);
        let convInfo = churnConversation(convId, null, [message]);
        newConversations.push(convInfo);
      });

      emitter.on('change', (serverMessageId, changes) => {
        syncState.messageChanged(serverMessageId, changes);
      });

      emitter.on('remove', (serverMessageId) => {
        syncState.messageDeleted(serverMessageId);
      });

      //

      // It's possible for our syncKey to be invalid, in which case we'll need
      // to run the logic a second time (fetching a syncKey and re-enumerating)
      // so use a loop that errs on the side of not looping.
      let syncKeyTriesAllowed = 1;
      while(syncKeyTriesAllowed--) {
        // - Infer the filter type, if needed.
        // XXX allow the explicit account-level override for filter types.
        // For now we're just pretending auto, which is probably the best option
        // for users in general.  (Unless there was a way to cap the number of
        // messages?  We would want that failsafe...)
        if (!syncState.filterType) {
          logic(ctx, 'inferringFilterType');
          // NB: manual destructing to shut up jslint.
          let results = yield* inferFilterType(
              conn,
              {
                folderServerId: folderInfo.serverId,
                desiredMessageCount: SYNC_WHOLE_FOLDER_AT_N_MESSAGES
              });
          syncState.syncKey = results.syncKey;
          syncState.filterType = results.filterType;
        }

        // - Get a sync key if needed
        if (!syncState.syncKey || syncState.syncKey === '0') {
          syncState.syncKey = (yield* getFolderSyncKey(
            conn,
            {
              folderServerId: folderInfo.serverId,
              filterType: syncState.filterType
            })).syncKey;
        }

        // - Try and sync
        let { invalidSyncKey, syncKey, moreToSync } =
          yield* enumerateFolderChanges(
            conn,
            {
              folderSyncKey: syncState.syncKey,
              folderServerId: folderInfo.serverId,
              filterType: syncState.filterType,
              issueIds,
              emitter
            });

        if (invalidSyncKey) {
          syncKeyTriesAllowed++;
          syncState.syncKey = '0';
          continue;
        }
        syncState.syncKey = syncKey;
        if (moreToSync) {
          syncState.scheduleAnotherRefreshLikeThisOne(req);
        }
      }

      // -- Issue name reads if needed.
      if (syncState.umidNameReads.size) {
        yield ctx.read({
          umidNames: syncState.umidNameReads // mutated as a side-effect.
        });
        syncState.generateSyncConvTasks();
      }
      // XXX lastSyncedAt / lastFolderSyncAt needs to get updated.

      yield ctx.finishTask({
        mutations: {
          syncStates: new Map([[req.folderId, syncState.rawSyncState]]),
          umidNames: syncState.umidNameWrites,
          umidLocations: syncState.umidLocationWrites
        },
        newData: {
          conversations: newConversations,
          messages: newMessages,
          tasks: syncState.tasksToSchedule
        }
      });
    })
  }
]);
});

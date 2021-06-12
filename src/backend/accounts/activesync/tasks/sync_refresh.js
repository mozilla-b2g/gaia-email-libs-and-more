import evt from 'evt';
import logic from 'logic';

import { shallowClone } from 'shared/util';
import { NOW } from 'shared/date';

import TaskDefiner from '../../../task_infra/task_definer';

import FolderSyncStateHelper from '../folder_sync_state_helper';

import getFolderSyncKey from '../smotocol/get_folder_sync_key';
import inferFilterType from '../smotocol/infer_filter_type';
import enumerateFolderChanges from '../smotocol/enum_folder_changes';

import { convIdFromMessageId, messageIdComponentFromUmid } from
  'shared/id_conversions';

import churnConversation from '../../../churn_drivers/conv_churn_driver';

import { SYNC_WHOLE_FOLDER_AT_N_MESSAGES } from '../../../syncbase';

import { syncNormalOverlay } from
  '../../../task_helpers/sync_overlay_helpers';

/**
 * Sync a folder for the first time and steady-state.  (Compare with our IMAP
 * implementations that have special "sync_grow" tasks.)
 */
export default TaskDefiner.defineAtMostOnceTask([
  {
    name: 'sync_refresh',
    binByArg: 'folderId',

    helped_overlay_folders: syncNormalOverlay,

    helped_invalidate_overlays: function(folderId, dataOverlayManager) {
      dataOverlayManager.announceUpdatedOverlayData('folders', folderId);
    },

    helped_already_planned: function(ctx, rawTask) {
      // The group should already exist; opt into its membership to get a
      // Promise
      return Promise.resolve({
        result: ctx.trackMeInTaskGroup('sync_refresh:' + rawTask.folderId)
      });
    },

    /**
     * In our planning phase we discard nonsensical requests to refresh
     * local-only folders.
     *
     * note: This is almost verbatim from the vanilla sync_refresh
     * implementation right now, except for s/serverPath/serverId.  We're on the
     * line right now between whether reuse would be better; keep it in mind as
     * things change.
     */
    async helped_plan(ctx, rawTask) {
      // Get the folder
      let foldersTOC =
        await ctx.universe.acquireAccountFoldersTOC(ctx, ctx.accountId);
      let folderInfo = foldersTOC.foldersById.get(rawTask.folderId);

      // - Only plan if the folder is real AKA it has a serverId.
      // (We could also look at its type.  Or have additional explicit state.
      // Checking the path is fine and likely future-proof.  The only real new
      // edge case we would expect is offline folder creation.  But in that
      // case we still wouldn't want refreshes triggered before we've created
      // the folder and populated it.)
      let plannedTask;
      if (!folderInfo.serverId) {
        plannedTask = null;
      } else {
        plannedTask = shallowClone(rawTask);
        plannedTask.resources = [
          'online',
          `credentials!${rawTask.accountId}`,
          `happy!${rawTask.accountId}`
        ];
        plannedTask.priorityTags = [
          `view:folder:${rawTask.folderId}`
        ];
      }

      // Create a task group that follows this task and all its offspring.  This
      // will define the lifetime of our overlay as well.
      let groupPromise =
        ctx.trackMeInTaskGroup('sync_refresh:' + rawTask.folderId);
      return {
        taskState: plannedTask,
        remainInProgressUntil: groupPromise,
        result: groupPromise
      };
    },

    async helped_execute(ctx, req) {
      // -- Exclusively acquire the sync state for the folder
      let fromDb = await ctx.beginMutate({
        syncStates: new Map([[req.folderId, null]])
      });

      let rawSyncState = fromDb.syncStates.get(req.folderId);
      let syncState = new FolderSyncStateHelper(
        ctx, rawSyncState, req.accountId, req.folderId, 'refresh');

      let account = await ctx.universe.acquireAccount(ctx, req.accountId);
      let conn = await account.ensureConnection();

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

      // It's possible for our syncKey to be invalid, in which case we'll need
      // to run the logic a second time (fetching a syncKey and re-enumerating)
      // so use a loop that errs on the side of not looping.
      let syncKeyTriesAllowed = 1;
      let syncDate;
      while(syncKeyTriesAllowed--) {
        // - Infer the filter type, if needed.
        // XXX allow the explicit account-level override for filter types.
        // For now we're just pretending auto, which is probably the best option
        // for users in general.  (Unless there was a way to cap the number of
        // messages?  We would want that failsafe...)
        if (!syncState.filterType) {
          logic(ctx, 'inferringFilterType');
          // NB: manual destructing to shut up jslint.
          let results = await inferFilterType(
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
          syncState.syncKey = (await getFolderSyncKey(
            conn,
            {
              folderServerId: folderInfo.serverId,
              filterType: syncState.filterType
            })).syncKey;
        }

        // - Try and sync
        syncDate = NOW();
        let { invalidSyncKey, syncKey, moreToSync } =
          await enumerateFolderChanges(
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
        await ctx.read({
          umidNames: syncState.umidNameReads // mutated as a side-effect.
        });
        syncState.generateSyncConvTasks();
      }

      return {
        mutations: {
          syncStates: new Map([[req.folderId, syncState.rawSyncState]]),
          umidNames: syncState.umidNameWrites,
          umidLocations: syncState.umidLocationWrites
        },
        newData: {
          conversations: newConversations,
          messages: newMessages,
          tasks: syncState.tasksToSchedule
        },
        atomicClobbers: {
          folders: new Map([
            [
              req.folderId,
              {
                lastSuccessfulSyncAt: syncDate,
                lastAttemptedSyncAt: syncDate,
                failedSyncsSinceLastSuccessfulSync: 0
              }
            ]])
        }
      };
    }
  }
]);

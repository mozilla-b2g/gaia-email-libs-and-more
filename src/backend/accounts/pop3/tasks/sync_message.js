import { shallowClone } from 'shared/util';
import { prioritizeNewer } from '../../../date_priority_adjuster';

import TaskDefiner from '../../../task_infra/task_definer';

import { resolveConversationTaskHelper } from '../../../task_mixins/conv_resolver';

import { conversationMessageComparator } from '../../../db/comparators';

import churnConversation from '../../../churn_drivers/conv_churn_driver';

/**
 * Fetch the envelope and snippet for a POP3 message and create and thread the
 * message.
 */
export default TaskDefiner.defineSimpleTask([
  {
    name: 'sync_message',

    async plan(ctx, rawTask) {
      let plannedTask = shallowClone(rawTask);

      // We don't have any a priori name-able exclusive resources.
      plannedTask.exclusiveResources = [
      ];

      plannedTask.priorityTags = [
      ];

      // Prioritize the message based on how new it is.
      if (rawTask.dateTS) {
        plannedTask.relPriority = prioritizeNewer(rawTask.dateTS);
      }

      await ctx.finishTask({
        taskState: plannedTask
      });
    },

    async execute(ctx, req) {
      // -- Exclusively acquire the sync state for the folder
      // NB: We don't actually need this right now since the connection knows
      // the UIDL to message number mapping.  But if it gets optimized more, it
      // would want this persistent state.
      /*
      let fromDb = await ctx.beginMutate({
        syncStates: new Map([[req.accountId, null]])
      });
      let rawSyncState = fromDb.syncStates.get(req.accountId);
      let syncState = new SyncStateHelper(
        ctx, rawSyncState, req.accountId, 'message');
      */

      // -- Establish the connection
      let account = await ctx.universe.acquireAccount(ctx, req.accountId);
      let popAccount = account.popAccount;
      let conn = await popAccount.ensureConnection();

      // -- Make sure the UIDL mapping is active
      await conn.loadMessageList(); // we don't care about the return value.

      let messageNumber = conn.uidlToId[req.uidl];

      let messageInfo =
        await conn.downloadPartialMessageByNumber(messageNumber);

      // -- Resolve the conversation this goes in.
      let { convId, existingConv, messageId, headerIdWrites, extraTasks } =
        await resolveConversationTaskHelper(
          ctx, messageInfo, req.accountId, req.umid);

      // Perform fixups to make the messageInfo valid.
      let inboxInfo = account.getFirstFolderWithType('inbox');
      messageInfo.id = messageId;
      messageInfo.umid = req.umid;
      messageInfo.folderIds = new Set([inboxInfo.id]);

      // -- If the conversation existed, load it for re-churning
      let oldConvInfo;
      let allMessages;
      let newConversations, modifiedConversations;
      if (existingConv) {
        let fromDb = await ctx.beginMutate({
          conversations: new Map([[convId, null]]),
          messagesByConversation: new Map([[convId, null]])
        });

        oldConvInfo = fromDb.conversations.get(convId);
        let existingMessages = fromDb.messagesByConversation.get(convId);
        allMessages = existingMessages.concat([messageInfo]);
        allMessages.sort(conversationMessageComparator);
      } else {
        oldConvInfo = null;
        allMessages = [messageInfo];
      }

      let convInfo = churnConversation(convId, oldConvInfo, allMessages);

      if (existingConv) {
        modifiedConversations = new Map([[convId, convInfo]]);
      } else {
        newConversations = [convInfo];
      }

      await ctx.finishTask({
        mutations: {
          conversations: modifiedConversations,
          headerIdMaps: headerIdWrites,
          umidNames: new Map([[req.umid, messageId]])
        },
        newData: {
          conversations: newConversations,
          messages: [messageInfo],
          tasks: extraTasks
        }
      });
    },
  }
]);

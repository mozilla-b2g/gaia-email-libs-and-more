import logic from 'logic';

import { shallowClone } from 'shared/util';

import { prioritizeNewer } from '../../../date_priority_adjuster';


import TaskDefiner from '../../../task_infra/task_definer';

import churnConversation from '../../../churn_drivers/conv_churn_driver';
import { RecurringEventBundleChewer } from '../chew_event_bundle';


export default TaskDefiner.defineSimpleTask([
  {
    name: 'sync_uid',

    async plan(ctx, rawTask) {
      let plannedTask = shallowClone(rawTask);

      plannedTask.exclusiveResources = [
        `conv:${rawTask.convId}`
      ];

      plannedTask.priorityTags = [
        `view:conv:${rawTask.convId}`
      ];

      // Prioritize syncing the conversation by how new it is.
      if (rawTask.mostRecent) {
        plannedTask.relPriority = prioritizeNewer(rawTask.mostRecent);
      }

      await ctx.finishTask({
        taskState: plannedTask
      });
    },

    /**
     * Synchronize a calendar UID event bundle, where all the event data is
     * actually already known and provided as part of the task definition.
     */
    async execute(ctx, req) {
      let account = await ctx.universe.acquireAccount(ctx, req.accountId);
      let foldersTOC =
        await ctx.universe.acquireAccountFoldersTOC(ctx, ctx.accountId);

      // ## Begin Mutation
      let fromDb = await ctx.beginMutate({
        // It's explicitly possible the conversation doesn't exist yet, in that
        // case we'll get `undefined` back when we do the map lookup.  We do
        // need to be aware of this and make sure we use `newData` in that case.
        conversations: new Map([[req.convId, null]]),
        messagesByConversation: new Map([[req.convId, null]])
      });

      const oldMessages = fromDb.messagesByConversation.get(req.convId);
      const oldConvInfo = fromDb.conversations.get(req.convId);

      const eventChewer = new RecurringEventBundleChewer({
        convId: req.convId,
        uid: req.uid,
        rangeOldestTS: req.rangeOldestTS,
        rangeNewestTS: req.rangeNewestTS,
        jcalEvents: req.jcalEvents,
        oldConvInfo,
        oldMessages,
        foldersTOC,
      });
      eventChewer.chewEventBundle();

      let convInfo;
      // It's possible we don't want a conversation (anymore) if there are no
      // messages.
      if (eventChewer.allMessages.length) {
        convInfo = churnConversation(req.convId, oldConvInfo, eventChewer.allMessages);
      } else {
        convInfo = null;
      }

      // ## Finish the task
      // Properly mark the conversation as new or modified based on whether we
      // had an old conversation.
      let modifiedConversations, newConversations;
      if (oldConvInfo) {
        modifiedConversations = new Map([[req.convId, convInfo]]);
      } else if (convInfo) {
        newConversations = [convInfo];
      }

      await ctx.finishTask({
        mutations: {
          conversations: modifiedConversations,
          messages: eventChewer.modifiedMessageMap
        },
        newData: {
          conversations: newConversations,
          messages: eventChewer.newMessages
        }
      });
    },
  }
]);

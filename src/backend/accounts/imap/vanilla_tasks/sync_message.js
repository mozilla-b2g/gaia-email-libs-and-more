import { shallowClone } from 'shared/util';
import { prioritizeNewer } from '../../../date_priority_adjuster';

import TaskDefiner from '../../../task_infra/task_definer';

import { resolveConversationTaskHelper } from
  '../../../task_mixins/conv_resolver';

import { browserboxMessageToMimeHeaders, chewMessageStructure } from
  '../imapchew';

import { conversationMessageComparator } from '../../../db/comparators';

import churnConversation from '../../../churn_drivers/conv_churn_driver';

/**
 * What to fetch.  Note that we currently re-fetch the flags even though they're
 * provided as an argument to our task.  We shouldn't, but this is handy for
 * debugging right now and may end up being conditionally necessary in the
 * smarter CONDSTORE/QRESYNC cases.
 */
const INITIAL_FETCH_PARAMS = [
  'uid',
  'internaldate',
  'bodystructure',
  'flags',
  'BODY.PEEK[' +
    'HEADER.FIELDS ' +
    '(FROM TO CC BCC SUBJECT REPLY-TO MESSAGE-ID REFERENCES IN-REPLY-TO)]'
];

/**
 * @typedef {Object} SyncConvTaskArgs
 * @prop accountId
 * @prop folderId
 * @prop uid
 * @prop umid
 * @prop dateTS
 * @prop flags
 **/

/**
 * Fetch the envelope for a message so we have enough info to create the message
 * and to also thread the message into a conversation.  We create or update the
 * conversation during this process.
 */
export default TaskDefiner.defineSimpleTask([
  {
    name: 'sync_message',

    async plan(ctx, rawTask) {
      let plannedTask = shallowClone(rawTask);

      // We don't have any a priori name-able exclusive resources.  Our records
      // are either orthogonal or will only be dynamically discovered while
      // we're running.
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
      // -- Get the envelope
      let account = await ctx.universe.acquireAccount(ctx, req.accountId);
      let folderInfo = account.getFolderById(req.folderId);

      let { result: rawMessages } = await account.pimap.listMessages(
        ctx,
        folderInfo,
        [req.uid],
        INITIAL_FETCH_PARAMS,
        { byUid: true }
      );
      let msg = rawMessages[0];

      let headers = browserboxMessageToMimeHeaders(msg);

      // -- Resolve the conversation this goes in.
      let { convId, existingConv, messageId, headerIdWrites, extraTasks } =
        await resolveConversationTaskHelper(
          ctx, headers, req.accountId, req.umid);

      let messageInfo = chewMessageStructure(
        msg,
        headers,
        new Set([req.folderId]),
        msg.flags,
        convId,
        req.umid,
        messageId
      );


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

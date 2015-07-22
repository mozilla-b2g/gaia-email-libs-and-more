define(function(require) {
'use strict';

let co = require('co');
let { shallowClone } = require('../../util');
let { NOW } = require('../../date');

let TaskDefiner = require('../../task_definer');

let { resolveConversationTaskHelper } =
  require('../../tasks/mix_conv_resolver');

let { conversationMessageComparator } = require('../../db/comparators');

let churnConversation = require('app_logic/conv_churn');

const MAX_PRIORITY_BOOST = 99999;
const ONE_HOUR_IN_MSECS = 60 * 60 * 1000;

/**
 * Fetch the envelope and snippet for a POP3 message and create and thread the
 * message.
 */
return TaskDefiner.defineSimpleTask([
  {
    name: 'sync_message',

    plan: co.wrap(function*(ctx, rawTask) {
      let plannedTask = shallowClone(rawTask);

      // We don't have any a priori name-able exclusive resources.
      plannedTask.exclusiveResources = [
      ];

      plannedTask.priorityTags = [
      ];

      // Prioritize the message based on how new it is.  Newer messages are more
      // important, donchaknow.  This is a question of quantization/binning and
      // how much range we have/need/care about.  Since we currently let
      // relative priorities go from -10k to +10k (exclusive), using hours in
      // the past provides useful differentiation for ~23 years which is
      // sufficient for our needs. Note that this relative priority is frozen in
      // time at the instance of planning
      if (rawTask.dateTS) {
        plannedTask.relPriority = Math.max(
          -MAX_PRIORITY_BOOST,
          MAX_PRIORITY_BOOST -
            (NOW() - rawTask.dateTS) / ONE_HOUR_IN_MSECS
        );
      }

      yield ctx.finishTask({
        taskState: plannedTask
      });
    }),

    execute: co.wrap(function*(ctx, req) {
      // -- Exclusively acquire the sync state for the folder
      // NB: We don't actually need this right now since the connection knows
      // the UIDL to message number mapping.  But if it gets optimized more, it
      // would want this persistent state.
      /*
      let fromDb = yield ctx.beginMutate({
        syncStates: new Map([[req.accountId, null]])
      });
      let rawSyncState = fromDb.syncStates.get(req.accountId);
      let syncState = new SyncStateHelper(
        ctx, rawSyncState, req.accountId, 'message');
      */

      // -- Establish the connection
      let account = yield ctx.universe.acquireAccount(ctx, req.accountId);
      let popAccount = account.popAccount;
      let conn = yield popAccount.ensureConnection();

      // -- Make sure the UIDL mapping is active
      yield conn.loadMessageList(); // we don't care about the return value.

      let messageNumber = conn.uidlToId[req.uidl];

      let messageInfo =
        yield conn.downloadPartialMessageByNumber(messageNumber);

      // -- Resolve the conversation this goes in.
      let { convId, existingConv, messageId, headerIdWrites, extraTasks } =
        yield* resolveConversationTaskHelper(
          ctx, messageInfo, req.accountId, req.umid);

      // Perform fixups to make the messageInfo valid.
      let inboxInfo = account.getFirstFolderWithType('inbox');
      messageInfo.id = messageId;
      messageInfo.umid = req.umid;
      messageInfo.folderIds.push(inboxInfo.id);

      // -- If the conversation existed, load it for re-churning
      let oldConvInfo;
      let allMessages;
      let newConversations, modifiedConversations;
      if (existingConv) {
        let fromDb = yield ctx.beginMutate({
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

      yield ctx.finishTask({
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
    }),
  }
]);

});

define(function(require) {
'use strict';

let co = require('co');
let { shallowClone } = require('../../util');
let { prioritizeNewer } = require('../../date_priority_adjuster');

let TaskDefiner = require('../../task_definer');

let { resolveConversationTaskHelper } =
  require('../../tasks/mix_conv_resolver');

let { conversationMessageComparator } = require('../../db/comparators');

let churnConversation = require('../../churn_drivers/conv_churn_driver');

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

      // Prioritize the message based on how new it is.
      if (rawTask.dateTS) {
        plannedTask.relPriority = prioritizeNewer(rawTask.dateTS);
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

define(function(require) {
'use strict';

const co = require('co');

const TaskDefiner = require('../task_definer');
const churnConversation = require('app_logic/conv_churn');


/**
 * Delete the draft without any type of undo mechanism.
 * TODO: Any type of undo mechanism ;)
 *
 * This is quite simple right now.  We just load the conversation, re-chew it,
 * and save the modified conversation with the message deleted.
 */
return TaskDefiner.defineSimpleTask([
  {
    name: 'draft_delete',

    plan: co.wrap(function*(ctx, req) {
      let { messageId } = req;
      let convId = convIdFromMessageId(messageId);
      let fromDb = yield ctx.beginMutate({
        conversations: new Map([[convId, null]]),
        messagesByConversation: new Map([[convId, null]])
      });

      let messages = fromDb.messagesByConversation.get(convId);
      let modifiedMessagesMap = new Map();

      let draftIndex = messages.findIndex(msg => msg.id === messageId);
      if (draftIndex === -1) {
        throw new Error('moot');
      }
      messages.splice(draftIndex, 1);

      modifiedMessagesMap.set(messageId, null);

      let oldConvInfo = fromDb.conversations.get(req.convId);
      let convInfo = churnConversation(convId, oldConvInfo, messages);

      yield ctx.finishTask({
        mutations: {
          conversations: new Map([[convId, convInfo]]),
          messages: modifiedMessagesMap
        }
      });
    }),

    execute: null
  }
]);
});

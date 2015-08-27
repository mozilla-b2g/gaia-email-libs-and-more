define(function(require) {
'use strict';

const co = require('co');

const TaskDefiner = require('../task_definer');
const churnConversation = require('../churn_drivers/conv_churn_driver');

const { convIdFromMessageId } = require('../id_conversions');

/**
 * Per-account task to remove an attachment from a draft.  This is trivial and
 * very similar to saving a draft, so will likely be consolidated.
 */
return TaskDefiner.defineSimpleTask([
  {
    name: 'draft_detach',

    plan: co.wrap(function*(ctx, req) {
      let { messageId } = req;
      let convId = convIdFromMessageId(messageId);
      let fromDb = yield ctx.beginMutate({
        conversations: new Map([[convId, null]]),
        messagesByConversation: new Map([[convId, null]])
      });

      let messages = fromDb.messagesByConversation.get(convId);
      let modifiedMessagesMap = new Map();

      let messageInfo = messages.find(msg => msg.id === messageId);
      if (messageInfo === null) {
        throw new Error('moot');
      }

      // -- Update the message.
      let attachmentIndex =
        messageInfo.attachments.findIndex(
          att => att.relId === req.attachmentRelId);
      if (attachmentIndex === -1) {
        throw new Error('moot');
      }
      messageInfo.attachments.splice(attachmentIndex, 1);
      messageInfo.hasAttachments = messageInfo.attachments.length > 0;
      modifiedMessagesMap.set(messageId, messageInfo);

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

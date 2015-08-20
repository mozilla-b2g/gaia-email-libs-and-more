define(function(require) {
'use strict';

const co = require('co');

const TaskDefiner = require('../task_definer');
const churnConversation = require('../churn_drivers/conv_churn_driver');

/**
 * Per-account task to update the non-attachment parts of an existing draft.
 *
 * This is quite simple right now.  We just load the conversation, re-chew it,
 * and save the modified conversation and message.
 */
return TaskDefiner.defineSimpleTask([
  {
    name: 'draft_save',

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
      let draftFields = req.draftFields;
      messageInfo.date = draftFields.date;
      messageInfo.to = draftFields.to;
      messageInfo.cc = draftFields.cc;
      messageInfo.bcc = draftFields.bcc;
      messageInfo.subject = draftFields.subject;
      // - Update the body rep
      let textRep = messageInfo.bodyReps.find((rep) => {
        return rep.type === 'plain';
      });
      textRep.contentBlob =
        new Blob([JSON.stringify([0x1, draftFields.textBody])],
                                 { type: 'application/json' });

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

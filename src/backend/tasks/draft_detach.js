import TaskDefiner from '../task_infra/task_definer';
import churnConversation from '../churn_drivers/conv_churn_driver';

import { convIdFromMessageId } from 'shared/id_conversions';

/**
 * Per-account task to remove an attachment from a draft.  This is trivial and
 * very similar to saving a draft, so will likely be consolidated.
 */
export default TaskDefiner.defineSimpleTask([
  {
    name: 'draft_detach',

    async plan(ctx, req) {
      let { messageId } = req;
      let convId = convIdFromMessageId(messageId);
      let fromDb = await ctx.beginMutate({
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

      await ctx.finishTask({
        mutations: {
          conversations: new Map([[convId, convInfo]]),
          messages: modifiedMessagesMap
        }
      });
    },

    execute: null
  }
]);

import TaskDefiner from '../task_infra/task_definer';

import { accountIdFromFolderId, accountIdFromMessageId, convIdFromMessageId }
  from 'shared/id_conversions';

import { NOW } from 'shared/date';

import { generateMessageIdHeaderValue } from '../bodies/mailchew';

import deriveBlankDraft from '../drafts/derive_blank_draft';
import deriveInlineForward from '../drafts/derive_inline_forward';
import deriveQuotedReply from '../drafts/derive_quoted_reply';

import churnConversation from '../churn_drivers/conv_churn_driver';

/**
 * Global task to create a new message (either a blank one, a reply, or a
 * forward) and save it to the database.  The MailBridge can then read and send
 * that (largely normal) message rep to the front-end.
 *
 * This is a global task because the decision of what account the draft should
 * be associated with is made during the process of constructing the draft.
 * (And we really don't want the front-end trying to figure the right answer out
 * on its own.)
 */
export default TaskDefiner.defineSimpleTask([
  {
    name: 'draft_create',

    async plan(ctx, req) {
      // -- Determine Account
      // This one is easy, it's the account the message belongs to or the folder
      // belongs to.
      let accountId;
      if (req.refMessageId) {
        accountId = accountIdFromMessageId(req.refMessageId);
      } else if (req.folderId) {
        // NB: If/when we get unified folders, this is not going to be
        // sufficiently correct.
        accountId = accountIdFromFolderId(req.folderId);
      }

      let account = await ctx.universe.acquireAccount(ctx, accountId);
      let draftFolderInfo = account.getFirstFolderWithType('localdrafts');

      // -- Determine identity
      // This one is currently easy since we only support a single identity, but
      // will get more complicated in the future when we support multiple
      // identities per account.
      let identity = account.identities[0];

      // -- Determine ConversationId and MessageId values
      let convId; // The conversation this message belongs to.
      let messageId; // The full messageId with conversationId baked in.
      // In order to avoid conflicting with server-allocated identifiers, we
      // use "~" which is not used by our a64 encoding as a prefix in
      // conjunction with another identifier that's unique within this space.
      // For the current sake of simplicity, we just use the task id.
      let messageIdPiece = '~' + ctx.id;
      let umid = accountId + '.' + messageIdPiece;
      if (req.draftType === 'blank' || req.draftType === 'forward') {
        // Fresh compose contexts and forwards mean new conversations.
        convId = accountId + '.' + messageIdPiece;
        messageId = convId + '.' + messageIdPiece;
      } else if (req.draftType === 'reply') {
        convId = convIdFromMessageId(req.refMessageId);
        messageId = convId + '.' + messageIdPiece;
      } else {
        throw new Error('invalid draft type: ' + req.draftType);
      }

      // -- Metadata that gets updated every draft save
      let guid = generateMessageIdHeaderValue();
      let date = NOW();

      // -- Derive the message
      let allMessages;
      let oldConvInfo;
      let messageInfo;
      let folderIds = new Set([draftFolderInfo.id]);
      // - Blank Compose
      if (req.draftType === 'blank') {
        // No need for a body, just generate it up.
        messageInfo = deriveBlankDraft({
          identity,
          messageId,
          umid,
          guid,
          date,
          folderIds
        });

        allMessages = [messageInfo];
      }
      // - Reply
      else if (req.draftType === 'reply') {
        // Load the conversation and its messages, acquiring a lock.
        let fromDb = await ctx.beginMutate({
          conversations: new Map([[convId, null]]),
          messagesByConversation: new Map([[convId, null]])
        });

        oldConvInfo = fromDb.conversations.get(convId);
        let loadedMessages = fromDb.messagesByConversation.get(convId);

        let sourceMessage =
          loadedMessages.find(msg => msg.id === req.refMessageId);

        messageInfo = await deriveQuotedReply({
          sourceMessage,
          replyMode: req.mode,
          identity,
          messageId,
          umid,
          guid,
          date,
          folderIds
        });

        allMessages = loadedMessages.concat([messageInfo]);
      }
      // - Forward
      else {
        // Load the source message (which does *not* form part of our new
        // conversation.)
        let sourceMessageKey = [req.refMessageId, req.refMessageDate];
        let fromDb = await ctx.beginMutate({
          messages: new Map([[sourceMessageKey, null]])
        });
        let sourceMessage = fromDb.messages.get(req.refMessageId);

        messageInfo = await deriveInlineForward({
          sourceMessage,
          identity,
          messageId,
          umid,
          guid,
          date,
          folderIds
        });

        allMessages = [messageInfo];
      }

      let convInfo = churnConversation(convId, oldConvInfo, allMessages);

      if (oldConvInfo) {
        await ctx.finishTask({
          mutations: {
            conversations: new Map([[convId, convInfo]]),
          },
          newData: {
            messages: [messageInfo]
          }
        });
      } else {
        await ctx.finishTask({
          newData: {
            conversations: [convInfo],
            messages: [messageInfo]
          }
        });
      }

      // Return the message id and date of the draft we have created.  Returning
      // this info (versus having something notice for out-of-band side-effects)
      // is the only sane way to convey this information.  (Even though in
      // general we don't want tasks to directly return information.)
      return ctx.returnValue({ messageId, messageDate: date });
    },

    execute: null
  }
]);

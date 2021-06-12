import TaskDefiner from '../../../task_infra/task_definer';

import churnConversation from '../../../churn_drivers/conv_churn_driver';

import MixinSyncBody from '../../../task_mixins/mix_sync_body';

/**
 * A custom execute() implementation building on top of Vanilla IMAP's sync_body
 * plan() implementation and general implementation strategy.
 *
 * Our rationale is similar to ActiveSync's where we adopt the same
 * custom-execute strategy:
 * - We're just downloading stuff in a single go since we have no concept of
 *   bodystructure, so the part logic doesn't matter to us.
 * - We have to deal with the side-effects of that, spawning attachments to be
 *   separate things.
 *
 * Note that there is a resource-usage concern to our adoption of this
 * conversation-centric transaction strategy since we're potentially downloading
 * a serious amount of information per-message.  This is potentially mitigated
 * by UI access patterns if the UI only shows one message at a time (ex: gaia
 * mail).  The integration of mcav's streaming changes should help eliminate
 * this as an issue.
 *
 * NOTE: We are emergently only used for body downloading.  This is because
 * sync_message already downloads snippets for messages as their envelopes are
 * fetched.  So no-one will try and use us for snippets.  If they do, we'll
 * end up downloading the entirety of the message, which could be bad.
 */
export default TaskDefiner.defineComplexTask([
  MixinSyncBody,
  {
    async execute(ctx, persistentState, memoryState, marker) {
      let req = memoryState.get(marker.convId);

      // -- Acquire the account and establish a connection
      let account = await ctx.universe.acquireAccount(ctx, marker.accountId);
      let popAccount = account.popAccount;
      let conn = await popAccount.ensureConnection();

      // -- Retrieve the conversation and its messages for mutation
      let fromDb = await ctx.beginMutate({
        conversations: new Map([[req.convId, null]]),
        messagesByConversation: new Map([[req.convId, null]])
      });

      let oldConvInfo = fromDb.conversations.get(req.convId);
      let loadedMessages = fromDb.messagesByConversation.get(req.convId);
      let modifiedMessagesMap = new Map();

      // -- Get the message locations
      let umidLocations = new Map();
      for (let message of loadedMessages) {
        umidLocations.set(message.umid, null);
      }

      // We need to look up all the umidLocations.
      await ctx.read({
        umidLocations
      });

      // -- Make sure the UIDL mapping is active
      await conn.loadMessageList(); // we don't care about the return value.

      // -- For each message...
      for (let message of loadedMessages) {
        // If this message isn't explicitly opted-in, skip it.
        if ((!req.fullBodyMessageIds ||
             !req.fullBodyMessageIds.has(message.id))) {
          continue;
        }

        let uidl = umidLocations.get(message.umid);
        let messageNumber = conn.uidlToId[uidl];

        let newMessageInfo =
          await conn.downloadMessageByNumber(messageNumber);

        // Propagate the things that can change across.  Which is all to do with
        // body parts and things derived from body parts.
        message.hasAttachments = newMessageInfo.hasAttachments;
        message.snippet = newMessageInfo.snippet;
        message.attachments = newMessageInfo.attachments;
        message.relatedParts = newMessageInfo.relatedParts;
        message.bodyReps = newMessageInfo.bodyReps;
        message.bytesToDownloadForBodyDisplay = 0;

        modifiedMessagesMap.set(message.id, message);
      }

      // -- Update the conversation
      let convInfo = churnConversation(req.convId, oldConvInfo, loadedMessages);

      // since we're successful at this point, clear it out of the memory state.
      // TODO: parallelizing: see notes in mix_sync_body's execute or just
      // steal its implementation if the todo is gone.
      memoryState.delete(req.convId);

      await ctx.finishTask({
        mutations: {
          conversations: new Map([[req.convId, convInfo]]),
          messages: modifiedMessagesMap
        },
      });
    }
  }
]);


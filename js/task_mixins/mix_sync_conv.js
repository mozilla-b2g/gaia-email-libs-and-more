import churnConversation from '../churn_drivers/conv_churn_driver';

/**
 * Planning-only task mix-in that applies modifications to a conversation based
 * on other sync logic.
 *
 * Consumers should provide:
 * - name
 * - applyChanges(messages, changeMapValue)
 */
export default {
  async plan(ctx, req) {
    let fromDb = await ctx.beginMutate({
      conversations: new Map([[req.convId, null]]),
      messagesByConversation: new Map([[req.convId, null]])
    });

    let loadedMessages = fromDb.messagesByConversation.get(req.convId);
    let modifiedMessagesMap = new Map();
    let umidNameWrites = new Map();

    let keptMessages = [];
    for (let message of loadedMessages) {
      if (req.removedUmids && req.removedUmids.has(message.umid)) {
        // delete the message
        modifiedMessagesMap.set(message.id, null);
        // delete the umid namer for it.
        // (We do this rather than sync_refresh because it's also sync logic
        // that initially performs the write, so it's more consistent for us
        // to do this and allows us to more easily avoid record resurrection.)
        umidNameWrites.set(message.umid, null);
      } else {
        // kept, possibly modified
        keptMessages.push(message);
        if (req.modifiedUmids && req.modifiedUmids.has(message.umid)) {
          this.applyChanges(message, req.modifiedUmids.get(message.umid));

          modifiedMessagesMap.set(message.id, message);
        }
      }
    }

    let convInfo;

    if (keptMessages.length) {
      let oldConvInfo = fromDb.conversations.get(req.convId);
      convInfo = churnConversation(req.convId, oldConvInfo, keptMessages);
    } else {
      // Flag the conversation for deletion.
      convInfo = null;
      // TODO: we are going to leak headerIdMap entries.  The logic should
      // recover if a conversation comes back, but we need to have some way
      // to deal with this.  Ideas:
      // - Automatically derived index:
      //  - from the conversation (requires strict churn cooperation or us to
      //    wrap the churn's output.  probably not a bad idea.)
      //  - from the messages.  This avoids churn headaches but potentially
      //    results in massive duplication in the index since it will result
      //    in O(n^2) entries in the pathological reply case.
      //  - 1:1 mapping placeholders whose keys are all prefixed by the
      //    conversationId so we can efficiently do a range deletion on the
      //    conversation and that wipes out the mappings without having to
      //    scatter/gather ourselves.  And because our mapping place-holders
      //    are named so that they are clobbered by duplicate information,
      //    it's just N keys with N derived indices.
      // - Periodic correctness sweep that garbage collects.
      //
      // At first glance, I'm liking the 1:1 mapping placeholders with
      // automatic indexing.
    }

    await ctx.finishTask({
      mutations: {
        conversations: new Map([[req.convId, convInfo]]),
        messages: modifiedMessagesMap,
        umidNames: umidNameWrites
      }
    });
  },

  execute: null
};

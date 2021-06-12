/**
 * @typedef {null} SyncBodyPersistentState
 *
 * All sync_body requests are currently ephemeral.
 **/

/**
 * @typedef {Object} SyncBodyPerConversation
 *   The per-conversation requested state.
 * @prop {ConversationId} convId
 * @prop {'snippet'|Number} amount
 *   If non-zero, this is a request to ensure that at least `amount` bytes of
 *   each message are downloaded for every message in the conversation.
 * @prop {Set} fullBodyMessageIds
 *   The set of messages for which we want to perform a full download.
 **/

/**
 * @typedef {Map<ConversationId, SyncBodyPerConversation>} SyncBodyMemoryState
 *
 *
 **/

/**
 * @typedef {Object} SyncBodyTaskArgs
 * @prop AccountId
 * @prop ConvId
 * @prop {'snippet'|Number} amount
 *   How much of each message should be fetched.  If omitted, the entirety of
 *   the message will be fetched.  If 'snippet' is provided, an appropriate
 *   value will automatically be chosen.  (Currently, the sybase constant
 *   `MAX_SNIPPET_BYTES` is used.)
 * @prop {Set} fullBodyMessageIds
 *   Messages for which we want to download the whole body.
 **/

/**
 * Fetch the body of messages, or part of the bodies of messages if we just want
 * a snippet.  We will also update the message and the conversation summary as
 * part of this process.  This all happens along conversation boundaries for
 * locality/parallelization reasons.
 *
 * This is currently a non-persisting complex task.  The rationale is:
 * - Snippet and body display is currently (and historically) an on-demand
 *   process.  When we restore state, it's possible the user won't exhibit the
 *   same access pattern.
 * - During the prototype phase, it's nice if things temporarily go off the
 *   rails (especially because of front-end UI bugs), that the undesired
 *   side-effects go away on restart.
 */
export default {
  name: 'sync_body',

  /**
   * @return {SyncBodyPersistentState}
   */
  initPersistentState() {
    return null;
  },

  /**
   */
  deriveMemoryStateFromPersistentState(/*persistentState*/) {
    return {
      memoryState: new Map(),
      markers: []
    };
  },

  async plan(ctx, persistentState, memoryState, rawTask) {
    // - Check whether we already have a pending request for the conversation.
    let planned = memoryState.get(rawTask.convId);
    if (planned) {
      // If the new task has an amount and we either don't have an existing
      // amount or the existing amount is 'snippet', just use whatever the new
      // task specifies.  (This covers snippet=>snippet and a change to
      // a number.  We're not doing any Math.max() but that's not particularly
      // an expected use case.  It avoids converting a number to a 'snippet'
      // which does cover the potential bounded-small-message-download logic
      // we might support.)
      if (rawTask.amount &&
          (!planned.amount || planned.amount === 'snippet')) {
        planned.amount = rawTask.amount;
      }
      if (rawTask.fullBodyMessageIds) {
        if (planned.fullBodyMessageIds) {
          // (copy-on-mutate)
          planned.fullBodyMessageIds = new Set(planned.fullBodyMessageIds);
          for (let messageId of rawTask.fullBodyMessageIds) {
            planned.fullBodyMessageIds.add(messageId);
          }
        } else {
          planned.fullBodyMessageIds = rawTask.fullBodyMessageIds;
        }
      }
    } else {
      planned = {
        // Uniqueify with our task name/prefix and the sufficiently unique
        // conversation id.
        markerId: 'sync_body:' + rawTask.convId,
        convId: rawTask.convId,
        amount: rawTask.amount,
        fullBodyMessageIds: rawTask.fullBodyMessageIds
      };
      memoryState.set(planned.convId, planned);
    }

    let priorityTags = [
      `view:conv:${planned.convId}`
    ];

    if (planned.fullBodyMessageIds) {
      for (let messageId of planned.fullBodyMessageIds) {
        priorityTags.push(`view:body:${messageId}`);
      }
    }

    let modifyTaskMarkers = new Map([
      [
        planned.markerId,
        {
          type: this.name,
          id: planned.markerId,
          accountId: rawTask.accountId,
          convId: planned.convId,
          priorityTags: priorityTags,
          exclusiveResources: [
            `conv:${planned.convId}`
          ]
        }
      ]
    ]);

    await ctx.finishTask({
      taskState: null,
      taskMarkers: modifyTaskMarkers
    });
  },
};


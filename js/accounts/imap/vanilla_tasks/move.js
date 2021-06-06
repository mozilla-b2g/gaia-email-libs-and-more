import TaskDefiner from '../../task_infra/task_definer';

import { normalizeAndApplyChanges, applyChanges, mergeChanges } from
  '../delta_algebra';
import { selectMessages } from '../message_selector';

import churnConversation from '../churn_drivers/conv_churn_driver';

/**
 * Vanilla IMAP MOVE implementation.  Derived from mix_store_flag.js but
 * dissimilar enough that we avoid mix-ins.
 *
 * Headline points:
 * - The plan phase operates on a conversation granularity.
 * - The execute phase operates on a per-message basis.  The current plan is to
 *   leave parallelization up to ParallelIMAP.
 * - Our execute phase has two paths based on capability:
 *   - MOVE + UIDPLUS-enabled.  If the server advertises support for both
 *     MOVE and UIDPLUS we will leverage the heck out of that.  If the server
 *     only advertises MOVE, we fall back to the RFC3501 path.
 *   -
 *
 * Not-particularly-clever flag-storing complex task.  All requests/local
 * manipulations are issued/planned on a conversation level.  At planning time
 * we switch over to per-umid tracking and do not bother attempting to perform
 * any type of batching inside ourselves because for sanity/simplicity we track
 * things at the umid level so we don't need to worry about message moves, etc.
 * The gmail logic gets to leverage the fact that there is (almost) a single,
 * unified namespace in the "all mail" folder so names are persistent and
 * unaffected by moves.  We need the umid's to compensate for this.
 *
 * (In the v1 job-op infrastructure we had a complex name-changing thing going
 * on that was a nightmare on many levels.)
 *
 * Basic implementation overview:
 *
 * - We are complex so that repeated offline manipulations of flag state
 *   result in at most one set of flag deltas per message.
 * - Being complex with a big aggregate state also lets the sync tasks consult
 *   us to know what flag changes are still pending and have not yet been played
 *   back to the server.  This avoids "flag flapping".
 * - Everything is keyed by umid/`UniqueMessageId`.  This is also the basis for
 *   the marker id.
 *
 * Caveats:
 * - Any batching is going to be emergent based on these tasks being run in
 *   parallel and the instantiating class having something like ParallelIMAP
 *   stitching requests together.  IMAP-wise, the good news is that in general
 *   most IMAP servers don't seem to wait for durable storage when manipulating
 *   flags, or just have fast/local storage.  (In previous development cycles
 *   gmail's write latency has been comparatively high and if manipulations
 *   aren't pipelined, this can result in poor throughput.)
 */
 /**
  * @see MixStoreFlagsMixin
  */
 export default TaskDefiner.defineComplexTask([
   {
     name: 'move',

    /**
     * @return {StoreFlagState}
     *   The initial state of this task type for a newly created account.
     */
    initPersistentState() {
      return {
        umidChanges: new Map()
      };
    },

    deriveMemoryStateFromPersistentState(persistentState, accountId) {
      let markers = [];

      for (let umid of persistentState.umidChanges.keys()) {
        markers.push({
          type: this.name,
          id: this.name + ':' + umid,
          accountId: accountId,
          umid: umid,
          priorityTags: [],
          exclusiveResources: []
        });
      }

      return {
        memoryState: {},
        markers
      };
    },

    async plan(ctx, persistentState, memoryState, req) {
      let { umidChanges } = persistentState;

      // -- Load the conversation and messages
      let fromDb = await ctx.beginMutate({
        conversations: new Map([[req.convId, null]]),
        messagesByConversation: new Map([[req.convId, null]])
      });

      let loadedMessages = fromDb.messagesByConversation.get(req.convId);
      let modifiedMessagesMap = new Map();
      let modifyTaskMarkers = new Map();
      let anyMessageChanged = false;

      // - Apply the message selector if applicable
      let filteredMessages = selectMessages(
        loadedMessages, req.onlyMessages, req.messageSelector);

      // -- Per message, compute the changes required and issue/update markers
      let undoTasks = [];
      for (let message of filteredMessages) {
        let actualChanges =
          normalizeAndApplyChanges(message.flags, req.add, req.remove);
        let { add: actuallyAdded, remove: actuallyRemoved } = actualChanges;

        if (actuallyAdded || actuallyRemoved) {
          // - Generate (non-minimal) undo tasks
          // (It's way too much work to optimize the undo case.)
          undoTasks.push({
            type: this.name,
            accountId: req.accountId,
            convId: req.convId,
            onlyMessages: [message.id],
            messageSelector: null,
            // invert the manipulation that was actually performed
            add: actuallyRemoved && actuallyRemoved.concat(),
            remove: actuallyAdded && actuallyAdded.concat()
          });

          modifiedMessagesMap.set(message.id, message);
          anyMessageChanged = true;

          let umid = message.umid;
          let markerId = this.name + ':' + umid;
          // - Unify with any outstanding request for this message
          if (umidChanges.has(umid)) {
            let mergedChanges =
              mergeChanges(umidChanges.get(umid), actualChanges);
            // It's possible that we now have nothing to tell the server to do.
            if (mergedChanges.add || mergedChanges.remove) {
              umidChanges.set(umid, mergedChanges);
              // we already have a marker for this one and there's no need to
              // change it, so we can just continue
              continue;
            }
            else {
              umidChanges.delete(umid);
              modifyTaskMarkers.set(markerId, null);
              continue;
            }
          }

          // Accumulate state iff there's an execute implementation.  POP3 is
          // local-only.  (We don't need to worry about the unify logic above
          // because umidChanges never gets any state put in it.)
          if (this.execute) {
            umidChanges.set(umid, actualChanges);
            modifyTaskMarkers.set(
              markerId,
              {
                type: this.name,
                id: markerId,
                accountId: req.accountId,
                umid,
                priorityTags: [],
                exclusiveResources: []
              });
          }
        }
      } // (end per-message loop)

      let conversationsMap = null;
      if (anyMessageChanged) {
        let oldConvInfo = fromDb.conversations.get(req.convId);
        let convInfo = churnConversation(
          req.convId, oldConvInfo, loadedMessages);
        conversationsMap = new Map([[convInfo.id, convInfo]]);
      }

      // (The local database state will already include any accumulated changes
      // requested by the user but not yet reflected to the server.  There is no
      // need to perform any transformation based on what is currently pending
      // because inbound sync does that and so we always seem a post-transform
      // view when looking in our database.)
      await ctx.finishTask({
        mutations: {
          conversations: conversationsMap,
          messages: modifiedMessagesMap
        },
        taskMarkers: modifyTaskMarkers,
        complexTaskState: persistentState
      });
    },

    /**
     * Exposed helper API for sync logic that wants the list of flags/labels
     * fixed-up to account for things we have not yet reflected to the server.
     */
    consult(askingCtx, persistentState, memoryState, argDict) {
      let { umid, value } = argDict;

      let { umidChanges } = persistentState;

      if (umidChanges.has(umid)) {
        let changes = umidChanges.get(umid);
        applyChanges(value, changes);
      }
    },

    async execute(ctx, persistentState, memoryState, marker) {
      let { umidChanges } = persistentState;

      let changes = umidChanges.get(marker.umid);

      let account = await ctx.universe.acquireAccount(ctx, marker.accountId);

      // -- Read the umidLocation
      let fromDb = await ctx.beginMutate({
        umidLocations: new Map([[marker.umid, null]])
      });

      let [ folderId, uid ] = fromDb.umidLocations.get(marker.umid);
      let folderInfo = account.getFolderById(folderId);

      // -- Issue the manipulations to the server
      if (changes.add && changes.add.length) {
        await account.pimap.store(
          ctx,
          folderInfo,
          [uid],
          '+' + this.imapDataName,
          changes.add,
          { byUid: true });
      }
      if (changes.remove && changes.remove.length) {
        await account.pimap.store(
          ctx,
          folderInfo,
          [uid],
          '-' + this.imapDataName,
          changes.remove,
          { byUid: true });
      }

      // - Success, clean up state.
      umidChanges.delete(marker.umid);

      // - Return / finalize
      await ctx.finishTask({
        complexTaskState: persistentState
      });
    },
  }
]);


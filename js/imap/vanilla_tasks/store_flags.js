define(function(require) {
'use strict';

let co = require('co');

let TaskDefiner = require('../../task_definer');

let { normalizeAndApplyChanges, applyChanges, mergeChanges } =
  require('../../delta_algebra');
let { selectMessages } = require('../../message_selector');

let churnConversation = require('app_logic/conv_churn');

/**
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
 * - Being complex with a big aggergate state also lets the sync tasks consult
 *   us to know what flag changes are still pending and have not yet been played
 *   back to the server.  This avoids "flag flapping".
 * - Everything is keyed by umid/`UniqueMessageId`.  This is also the basis for
 *   the marker id.
 *
 * Caveats:
 * - Any batching is going to be emergent based on these tasks being run in
 *   parallel and with ParallelIMAP stitching requests together.  The good news
 *   is that in general most IMAP servers don't seem to wait for durable storage
 *   when manipulating flags, or just have fast/local storage.  (In previous
 *   development cycles gmail's write latency has been comparatively high and
 *   if manipulations aren't pipelined, this can result in poor throughput.)
 */
return TaskDefiner.defineComplexTask([{
  name: 'store_flags',
  // We don't care about the fetch return, so don't bother.
  imapDataName: 'FLAGS.SILENT',

  /**
   * @return {StoreFlagState}
   *   The initial state of this task type for a newly created account.
   */
  initPersistentState: function() {
    return {
      umidChanges: new Map()
    };
  },

  deriveMemoryStateFromPersistentState: function(persistentState, accountId) {
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


  plan: co.wrap(function*(ctx, persistentState, memoryState, req) {
    let { umidChanges } = persistentState;

    // -- Load the conversation and messages
    let fromDb = yield ctx.beginMutate({
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
    yield ctx.finishTask({
      mutations: {
        conversations: conversationsMap,
        messages: modifiedMessagesMap
      },
      taskMarkers: modifyTaskMarkers,
      complexTaskState: persistentState
    });
  }),

  /**
   * Exposed helper API for sync logic that wants the list of flags/labels
   * fixed-up to account for things we have not yet reflected to the server.
   */
  consult: function(askingCtx, persistentState, memoryState, argDict) {
    let { umid, value } = argDict;

    let { umidChanges } = persistentState;

    if (umidChanges.has(umid)) {
      let changes = umidChanges.get(umid);
      applyChanges(value, changes);
    }
  },

  execute: co.wrap(function*(ctx, persistentState, memoryState,
                             marker) {
    let { umidChanges } = persistentState;

    let changes = umidChanges.get(marker.umid);

    let account = yield ctx.universe.acquireAccount(ctx, marker.accountId);

    // -- Read the umidLocation
    let fromDb = yield ctx.beginMutate({
      umidLocations: new Map([[marker.umid, null]])
    });

    let [ folderId, uid ] = fromDb.umidLocations.get(marker.umid);
    let folderInfo = account.getFolderMetaForFolderId(folderId);

    // -- Issue the manipulations to the server
    if (changes.add && changes.add.length) {
      yield account.pimap.store(
        folderInfo,
        [uid],
        '+' + this.imapDataName,
        changes.add,
        { byUid: true });
    }
    if (changes.remove && changes.remove.length) {
      yield account.pimap.store(
        folderInfo,
        [uid],
        '-' + this.imapDataName,
        changes.remove,
        { byUid: true });
    }

    // - Success, clean up state.
    umidChanges.delete(marker.umid);

    // - Return / finalize
    yield ctx.finishTask({
      complexTaskState: persistentState
    });
  })

}]);

});

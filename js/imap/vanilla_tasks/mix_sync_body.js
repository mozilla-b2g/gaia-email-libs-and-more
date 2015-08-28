define(function(require) {
'use strict';

let co = require('co');

let TaskDefiner = require('../../task_definer');

let imapchew = require('../imapchew');

let churnConversation = require('../../churn_drivers/conv_churn_driver');

let { SnippetParser } = require('../protocol/snippetparser');
let { TextParser } = require('../protocol/textparser');

let asyncFetchBlob = require('../../async_blob_fetcher');

const { MAX_SNIPPET_BYTES } = require('../../syncbase');

/**
 * Maximum bytes to request from server in a fetch request (max uint32)
 */
const MAX_FETCH_BYTES = (Math.pow(2, 32) - 1);


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
return TaskDefiner.defineComplexTask([
  {
    name: 'sync_body',

    /**
     * @return {SyncBodyPersistentState}
     */
    initPersistentState: function() {
      return null;
    },

    /**
     */
    deriveMemoryStateFromPersistentState: function(persistentState) {
      return {
        memoryState: new Map(),
        markers: []
      };
    },

    plan: co.wrap(function*(ctx, persistentState, memoryState, rawTask) {
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

      yield ctx.finishTask({
        taskState: null,
        taskMarkers: modifyTaskMarkers
      });
    }),

    execute: co.wrap(function*(ctx, persistentState, memoryState, marker) {
      let req = memoryState.get(marker.convId);

      // -- Retrieve the conversation and its messages for mutation
      let fromDb = yield ctx.beginMutate({
        conversations: new Map([[req.convId, null]]),
        messagesByConversation: new Map([[req.convId, null]])
      });

      let loadedMessages = fromDb.messagesByConversation.get(req.convId);
      let modifiedMessagesMap = new Map();

      let account = yield ctx.universe.acquireAccount(ctx, marker.accountId);

      let prepared = yield this.prepForMessages(ctx, account, loadedMessages);

      // Determine our byte budget for each message.  A zero budget means that
      // for fullBodyMessageIds-listed messages we will download them in their
      // entirety and do nothing else for the other messages.
      let maxBytesPerMessage = 0;
      if (req.amount === 'snippet') {
        maxBytesPerMessage = MAX_SNIPPET_BYTES;
      } else if (req.amount) {
        maxBytesPerMessage = req.amount;
      }

      // -- For each message...
      for (let message of loadedMessages) {
        let remainingByteBudget = maxBytesPerMessage;
        // If this message isn't explicitly opted-in and we have no snippety
        // budget, then skip this message.
        if (!remainingByteBudget &&
            (!req.fullBodyMessageIds ||
             !req.fullBodyMessageIds.has(message.id))) {
          continue;
        }
        let bodyRepIndex = imapchew.selectSnippetBodyRep(message);

        // -- For each body part...
        for (let iBodyRep=0; iBodyRep < message.bodyReps.length; iBodyRep++) {
          let rep = message.bodyReps[iBodyRep];
          // - Figure out what work, if any, to do.
          if (rep.isDownloaded) {
            continue;
          }

          // default to the entire remaining email. We use the estimate *
          // largish multiplier so even if the size estimate is wrong we should
          // fetch more then the requested number of bytes which if truncated
          // indicates the end of the bodies content.
          let bytesToFetch = Math.min(rep.sizeEstimate * 5, MAX_FETCH_BYTES);

          let bodyParser;
          let partDef = rep._partInfo;
          if (maxBytesPerMessage) {
            // issued enough downloads
            if (remainingByteBudget <= 0) {
              break;
            }

            // if our estimate is greater then expected number of bytes
            // request the maximum allowed.
            if (rep.sizeEstimate > remainingByteBudget) {
              bytesToFetch = remainingByteBudget;
            }
            // subtract the estimated byte size
            remainingByteBudget -= rep.sizeEstimate;

            bodyParser = new SnippetParser(partDef);
          } else {
            bodyParser = new TextParser(partDef);
          }

          // For a byte-serve request, we need to request at least 1 byte, so
          // request some bytes.  This is a logic simplification that should not
          // need to be used because imapchew.js should declare 0-byte files
          // fully downloaded when their parts are created, but better a
          // wasteful network request than breaking here.
          if (bytesToFetch <= 0) {
            bytesToFetch = 64;
          }

          let byteRange;
          if (maxBytesPerMessage || rep.amountDownloaded) {
            byteRange = [rep.amountDownloaded, bytesToFetch];
          }

          // If we had already downloaded part of the body, be sure to parse it.
          // It is stored out-of-line as a Blob, so must be (asynchronously)
          // fetched.
          if (partDef.pendingBuffer) {
            let loadedBuffer = new Uint8Array(
              yield asyncFetchBlob(partDef.pendingBuffer, 'arraybuffer'));
            bodyParser.parse(loadedBuffer);
          }

          // - Issue the fetch
          let { folderInfo, uid } = this.getFolderAndUidForMesssage(
            prepared, account, message);
          let rawBody = yield account.pimap.fetchBody(
            folderInfo,
            {
              uid,
              partInfo: rep._partInfo,
              bytes: byteRange
            });

          bodyParser.parse(rawBody);
          let bodyResult = bodyParser.complete();

          // - Update the message
          imapchew.updateMessageWithFetch(
            message,
            {
              bodyRepIndex: iBodyRep,
              createSnippet: iBodyRep === bodyRepIndex,
              bytes: byteRange
            },
            bodyResult
          );

          modifiedMessagesMap.set(message.id, message);
        }
      }

      // -- Update the conversation
      let convInfo = churnConversation(req.convId, null, loadedMessages);

      // since we're successful at this point, clear it out of the memory state.
      // TODO: when parallelizing, move this up the top and use it at the same
      // time as ctx.setFailureTasks in order to implement proper recovery
      // semantics.  (Although, honestly, sync_body is an inherently idempotent
      // sort of thing where the front-end is likely to re-issue requests, so
      // it's not the end of the world if we lose the request.)
      memoryState.delete(req.convId);

      yield ctx.finishTask({
        mutations: {
          conversations: new Map([[req.convId, convInfo]]),
          messages: modifiedMessagesMap
        },
      });
    })
  }
]);
});

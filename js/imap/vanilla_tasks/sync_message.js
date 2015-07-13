define(function(require) {
'use strict';

let co = require('co');
let { shallowClone } = require('../../util');
let { NOW } = require('../../date');

let TaskDefiner = require('../../task_definer');

let { resolveConversationTaskHelper } =
  require('../../tasks/mix_conv_resolver');

let { chewMessageStructure } = require('../imapchew');

let { conversationMessageComparator } = require('../../db/comparators');

let churnConversation = require('app_logic/conv_churn');

/**
 * What to fetch.  Note that we currently re-fetch the flags even though they're
 * provided as an argument to our task.  We shouldn't, but this is handy for
 * debugging right now and may end up being conditionally necessary in the
 * smarter CONDSTORE/QRESYNC cases.
 */
let INITIAL_FETCH_PARAMS = [
  'uid',
  'internaldate',
  'bodystructure',
  'flags',
  'BODY.PEEK[' +
    'HEADER.FIELDS ' +
    '(FROM TO CC BCC SUBJECT REPLY-TO MESSAGE-ID REFERENCES IN-REPLY-TO)]'
];

/**
 * @typedef {Object} SyncConvTaskArgs
 * @prop accountId
 * @prop folderId
 * @prop uid
 * @prop umid
 * @prop dateTS
 * @prop flags
 **/

const MAX_PRIORITY_BOOST = 99999;
const ONE_HOUR_IN_MSECS = 60 * 60 * 1000;

/**
 * Fetches the envelopes for new messages in a conversation and also applies
 * flag/label changes discovered by sync_refresh (during planning).
 *
 * XXX??? do the planning stuff in separate tasks.  just have the churner handle
 * things.
 *
 * For a non-new conversation where we are told revisedUidState, in the planning
 * phase, apply the revised flags/labels.  (We handle this rather than
 * sync_refresh because this inherently necessitates a recomputation of the
 * conversation summary which quickly gets to be more work than sync_refresh
 * wants to do in its step.)
 *
 * For a non-new conversation where we are told removedUids, in the planning
 * phase, remove the messages from the database and recompute the conversation
 * summary.
 *
 * For a new conversation, in the execution phase, do a SEARCH to find all the
 * headers, FETCH all their envelopes, and add the headers/bodies to the
 * database.  This requires loading and mutating the syncState.
 *
 * For a non-new conversation where we are told newUids, in the execution
 * phase, FETCH their envelopes and add the headers/bodies to the database.
 * This does not require loading or mutating the syncState; sync_refresh already
 * updated itself.
 */
return TaskDefiner.defineSimpleTask([
  {
    name: 'sync_message',

    plan: co.wrap(function*(ctx, rawTask) {
      let plannedTask = shallowClone(rawTask);

      // We don't have any a prioir name-able exclusive resources.  Our records
      // are either orthogonal or will only be dynamically discovered while
      // we're running.
      plannedTask.exclusiveResources = [
      ];

      plannedTask.priorityTags = [
      ];

      // Prioritize the message based on how new it is.  Newer messages are more
      // important, donchaknow.  This is a question of quantization/binning and
      // how much range we have/need/care about.  Since we currently let
      // relative priorities go from -10k to +10k (exclusive), using hours in
      // the past provides useful differentiation for ~23 years which is
      // sufficient for our needs. Note that this relative priority is frozen in
      // time at the instance of planning
      if (rawTask.dateTS) {
        plannedTask.relPriority = Math.max(
          -MAX_PRIORITY_BOOST,
          MAX_PRIORITY_BOOST -
            (NOW() - rawTask.dateTS) / ONE_HOUR_IN_MSECS
        );
      }

      yield ctx.finishTask({
        taskState: plannedTask
      });
    }),

    execute: co.wrap(function*(ctx, req) {
      // -- Get the envelope
      let account = yield ctx.universe.acquireAccount(ctx, req.accountId);
      let folderInfo = account.getFolderById(req.folderId);

      let { result: rawMessages } = yield account.pimap.listMessages(
        folderInfo,
        [req.uid],
        INITIAL_FETCH_PARAMS,
        { byUid: true }
      );
      let msg = rawMessages[0];

      // -- Resolve the conversation this goes in.
      let { convId, existingConv, messageId, headerIdWrites, extraTasks } =
        yield* resolveConversationTaskHelper(ctx, msg, req.accountId, req.umid);

      let messageInfo = chewMessageStructure(
        msg,
        [req.folderId],
        msg.flags,
        convId,
        req.umid,
        messageId
      );


      // -- If the conversation existed, load it for re-churning
      let oldConvInfo;
      let allMessages;
      let newConversations, modifiedConversations;
      if (existingConv) {
        let fromDb = yield ctx.beginMutate({
          conversations: new Map([[convId, null]]),
          messagesByConversation: new Map([[convId, null]])
        });

        oldConvInfo = fromDb.conversations.get(convId);
        let existingMessages = fromDb.messagesByConversation.get(convId);
        allMessages = existingMessages.concat([messageInfo]);
        allMessages.sort(conversationMessageComparator);
      } else {
        oldConvInfo = null;
        allMessages = [messageInfo];
      }

      let convInfo = churnConversation(convId, oldConvInfo, allMessages);

      if (existingConv) {
        modifiedConversations = new Map([[convId, convInfo]]);
      } else {
        newConversations = [convInfo];
      }

      yield ctx.finishTask({
        mutations: {
          conversations: modifiedConversations,
          headerIdMaps: headerIdWrites,
          umidNames: new Map([[req.umid, messageId]])
        },
        newData: {
          conversations: newConversations,
          messages: [messageInfo],
          tasks: extraTasks
        }
      });
    }),
  }
]);

});

define(function(require) {
'use strict';

let co = require('co');

let TaskDefiner = require('../../task_definer');
let a64 = require('../../a64');
let parseGmailMsgId = a64.parseUI64;
let parseGmailConvId = a64.parseUI64;
let expandGmailConvId = a64.decodeUI64;

let imapchew = require('../imapchew');
let parseImapDateTime = imapchew.parseImapDateTime;

let churnConversation = require('../../churns/conv_churn');


/**
 * Lose the account id prefix from a convId and convert the a64 rep into base 10
 */
function convIdToGmailThreadId(convId) {
  let a64Part = convId.substring(convId.indexOf('.') + 1);
  return expandGmailConvId(a64Part);
}


let INITIAL_FETCH_PARAMS = [
  'uid',
  'internaldate',
  'x-gm-msgid',
  'bodystructure',
  'flags',
  'x-gm-labels',
  'BODY.PEEK[' +
    'HEADER.FIELDS (FROM TO CC BCC SUBJECT REPLY-TO MESSAGE-ID REFERENCES)]'
];

/**
 * Fetches the envelopes for new messages in a conversation and also applies
 * flag/label changes discovered by sync_refresh (during planning).
 *
 * XXX do the planning stuff in separate tasks.  just have the churner handle
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
 *
 */
 return TaskDefiner.defineSimpleTask([
   {
     name: 'sync_conv',
     namingArgs: ['accountId', 'convId'],
     unifyingArgs: ['newConv', 'removeConv', 'newUids', 'removedUids',
                    'revisedUidState'],

     priorityTags: function(args) {
       return [
         `view:conv:${args.convId}`
       ];
     },

     execute: co.wrap(function*(ctx, req) {
       /** UIDs to fetch, we may not need to fetch any and this may stay null */
       let uids = null;
       let convLoadPromise, convMutateMap;

       let account = yield ctx.universe.acquireAccount(ctx, req.accountId);

       if (req.newConv) {
         // -- New conversation
         // Search for all the messages in the conversation
         let searchSpec = {
           'x-gm-thrid': convIdToGmailThreadId(args.convId)
         };
         let uids = yield account.pimap.search(
           req.folderId, searchSpec, { byUid: true });
         ctx.log('search found uids', { uids: uids });
       } else if (req.delConv) {
         // -- Delete conversation
         yield ctx.finishTask({
           
         });
       } else {
          // -- Existing conversation
          let uids = Array.from(args.uids);
          ctx.log('using provided uids', { uids: uids });

          // We need to load the conversation so we can mutate it.
          convMutateMap = new Map();
          convMutateMap.set(args.convId, null);
          convLoadPromise = task.beginMutate({ conv: mutateMap });
       }

       // -- Have (new to us) message envelopes to fetch
       if (uids) {
         let rawMessages = yield account.pimap.listMessages(
           req.folderId,
           uids,
           INITIAL_FETCH_PARAMS,
           { byUid: true }
         );

         // --
         let normalizedMessages = messages.map((msg) => {
           return {
             uid: msg.uid, // already parsed into a number by browserbox
             date: parseImapDateTime(msg.internaldate),
             msgId: parseGmailMsgId(msg['x-gm-msgid']),
             convId: parseGmailConvId(msg['x-gm-thrid'])
           };
         });

         normalizedMessages.sort(folderSyncDb.messageOrderingComparator);

       // -- Wait for the conversation to have loaded if we have one
       let convInfo;
       if (convLoadPromise) {
         yield convLoadPromise;
         convInfo = convMutateMap.get(convId);
       }

       convInfo = churnConversation(convInfo, newHeaders);

       let tasks = [];
       yield ctx.finishTask({
         mutations: {

         },
         newData: {

         }
       })
     })
   }
 ]);

});

define(function(require) {

let TaskDefiner = require('../../task_definer');
let a64 = require('../../a64');
let imapchew = require('../imapchew');
let churnConversation = require('../../churns/conv_churn');

let parseGmailMsgId = a64.parseUI64;
let parseGmailConvId = a64.parseUI64;
let expandGmailConvId = a64.decodeUI64;

/**
 * Lose the account id prefix from a convId and convert the a64 rep into base 10
 */
function convIdToGmailThreadId(convId) {
  let a64Part = convId.substring(convId.indexOf('.') + 1);
  return expandGmailConvId(a64Part);
}

let parseImapDateTime = imapchew.parseImapDateTime;

let INITIAL_FETCH_PARAMS = [
  'uid',
  'internaldate',
  'x-gm-msgid',
  'bodystructure',
  'flags',
  'x-gm-labels',
  'BODY.PEEK[HEADER.FIELDS (FROM TO CC BCC SUBJECT REPLY-TO MESSAGE-ID REFERENCES)]'
];

/**
 * Fetches the envelopes for new messages in a conversation.
 *
 * Given a conversation-id (X-GM-THRID), synchronize its state by going in the
 * all mail folder, issuing a SEARCH on the conversation, finding all the
 * messages,
 *
 */
 return TaskDefiner.defineSimpleTask([
   {
     name: 'sync_conv',
     namingArgs: ['convId'],
     // In the case
     unifyingArgs: ['uids'],

     priorityTags: [
       (args) => `view:conv:${args.convId}`
     ],

     plan: null,

     execute: function*(ctx, args) {
       let uids;
       let convLoadPromise, convMutateMap;

       // -- Figure out UIDS
       // - Existing conversation
       // If we were explicitly told the UIDs of the new messages in the
       // conversation, just use those.
       if (args.uids && args.uids.size) {
          let uids = Array.from(args.uids);
          ctx.log('using provided uids', { uids: uids });

          // We need to load the conversation so we can mutate it.
          convMutateMap = new Map();
          convMutateMap.set(args.convId, null);
          convLoadPromise = task.beginMutate({ conv: mutateMap });
       }
       // - New conversation
       else {
         // Search for all the messages in the conversation
         let searchSpec = {
           'x-gm-thrid': convIdToGmailThreadId(args.convId)
         }
         let uids = yield ctx.pimap.search(
           req.folderId, searchSpec, { byUid: true });
         ctx.log('search found uids', { uids: uids });
       }

       // -- Fetch the envelopes
       let rawMessages = yield ctx.pimap.listMessages(
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

       })
     }
   }
 ]);

});

define(function(require) {

var TaskDefiner = require('../../task_definer');
var a64 = require('../../a64');
var imapchew = require('../imapchew');

let parseGmailMsgId = a64.parseUI64;
let parseGmailConvId = a64.parseUI64;
let expandGmailConvId = a64.decodeUI64;

let parseImapDateTime = imapchew.parseImapDateTime;

let INITIAL_FETCH_PARAMS = [
  'uid',
  'internaldate',
  'x-gm-msgid',
  'bodystructure',
  'flags',
  'x-gm-labels'
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
     unifyingArgs: ['uids']

     priorityTags: [
       (args) => `view:conv:${args.convId}`
     ],

     plan: null,

     execute: function*(ctx, args) {
       let uids;

       // - Existing conversation
       // If we were explicitly told the UIDs of the new messages in the
       // conversation, just use those.
       if (args.uids && args.uids.size) {
          let uids = Array.from(args.uids);
          ctx.log('using provided uids', { uids: uids });
       }
       // - New conversation
       else {
         // Search for all the messages in the conversation
         let searchSpec = {
           'x-gm-thrid': expandGmailConvId(args.convId)
         }
         let uids = yield ctx.pimap.search(
           req.folderId, searchSpec, { byUid: true });
         ctx.log('search found uids', { uids: uids });
       }

       let rawMessages = yield.ctx.pimap.listMessages(
         req.folderId,
         uids,
         INITIAL_FETCH_PARAMS,
         { byUid: true }
       );



       let normalizedMessages = messages.map((msg) => {
         return {
           uid: msg.uid, // already parsed into a number by browserbox
           date: parseImapDateTime(msg.internaldate),
           msgId: parseGmailMsgId(msg['x-gm-msgid']),
           convId: parseGmailConvId(msg['x-gm-thrid'])
         };
       });

       normalizedMessages.sort(folderSyncDb.messageOrderingComparator);

       let tasks = [];
       yield ctx.finishTask({

       })
     }
   }
 ]);
 });

});

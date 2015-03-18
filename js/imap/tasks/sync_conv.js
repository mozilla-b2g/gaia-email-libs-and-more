define(function(require) {

var TaskDefiner = require('../../task_definer');
var a64 = require('../../a64');
var imapchew = require('../imapchew');

let parseGmailMsgId = a64.parseUI64;
let parseGmailConvId = a64.parseUI64;

let parseImapDateTime = imapchew.parseImapDateTime;

/**
 * Given a conversation-id (X-GM-THRID), synchronize its state by going in the
 * all mail folder, issuing a SEARCH on the conversation, detecting
 *
 */
 return TaskDefiner.defineSimpleTask([
   {
     name: 'sync_conv',
     args: ['convId'],
     run: function*(ctx, req) {
       // Get our current folder state.
       let folderSyncDb = ctx.account.folderSyncDbById.get(req.folderId);
       let folderState = yield folderSyncDB.getSyncState();

       // XXX growing needs BEFORE as well
       // Search covering through 2 days ago
       let startTS = Date.now() - 2 * 24 * 60 * 60 * 1000;
       let searchSpec = {
         // (gmail auto-expunges so we don't need to do a NOT DELETED thing)
         since: startTS
       }

       // Find out new UIDs covering the range in question.
       let uids = yield ctx.pimap.search(
         req.folderId, searchSpec, { byUid: true });
       ctx.log('got uids', { uids: uids });

       let messages = yield.ctx.pimap.listMessages(
         req.folderId,
         uids,
         [
           'uid',
           'internaldate',
           'x-gm-thrid',
           'x-gm-msgid'
         ],
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

define(function(require) {
'use strict';

let co = require('co');

let TaskDefiner = require('../../task_definer');

let churnConversation = require('app_logic/conv_churn');

/**
 * Planning-only task that applies modifications to a conversation based on
 * other sync logic.
 */
return TaskDefiner.defineSimpleTask([
  {
    name: 'sync_conv',

    plan: co.wrap(function*(ctx, req) {
      let fromDb = yield ctx.beginMutate({
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
            let newFlags = req.modifiedUmids.get(message.umid);
            message.flags = newFlags;

            modifiedMessagesMap.set(message.id, message);
          }
        }
      }

      let oldConvInfo = fromDb.conversations.get(req.convId);
      let convInfo = churnConversation(req.convId, oldConvInfo, keptMessages);

      yield ctx.finishTask({
        mutations: {
          conversations: new Map([[req.convId, convInfo]]),
          messages: modifiedMessagesMap,
          umidNames: umidNameWrites
        }
      });

      yield ctx.finishTask({
        // no further processing required.
        taskState: null
      });
    }),

    execute: null
  }
]);

});

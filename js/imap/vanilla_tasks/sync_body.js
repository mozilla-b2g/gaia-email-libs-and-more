define(function(require) {
'use strict';

let co = require('co');

let TaskDefiner = require('../../task_definer');

return TaskDefiner.defineComplexTask([
  require('./mix_sync_body'),
  {
    prepForMessages: co.wrap(function*(ctx, account, messages) {
      let umidLocations = new Map();
      for (let message of messages) {
        umidLocations.set(message.umid, null);
      }

      // We need to look up all the umidLocations.
      yield ctx.read({
        umidLocations
      });

      return umidLocations;
    }),

    getFolderAndUidForMesssage: function(umidLocations, account, message) {
      let [folderId, uid] = umidLocations.get(message.umid);
      return {
        folderInfo: account.getFolderById(folderId),
        uid
      };
    }
  }
]);
});

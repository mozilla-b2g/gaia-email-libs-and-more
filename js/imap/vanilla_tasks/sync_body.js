define(function(require) {
'use strict';

let TaskDefiner = require('../../task_definer');

return TaskDefiner.defineComplexTask([
  require('./mix_sync_body'),
  {
    prepForMessages: function*(ctx, account, messages) {
      let umidLocations = new Map();
      for (let message of messages) {
        umidLocations.set(message.umid, null);
      }

      // We need to look up all the umidLocations.
      yield ctx.read({
        umidLocations
      });

      return Promise.resolve(umidLocations);
    },

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

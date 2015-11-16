define(function(require) {
'use strict';

const co = require('co');

const TaskDefiner = require('../../task_infra/task_definer');

return TaskDefiner.defineComplexTask([
  require('../../task_mixins/mix_download'),
  require('../task_mixins/imap_mix_download'),
  {
    getFolderAndUidForMesssage: co.wrap(function*(ctx, account, message) {
      let [folderId, uid] = yield ctx.readSingle('umidLocations', message.umid);

      return {
        folderInfo: account.getFolderById(folderId),
        uid
      };
    }),
  }
]);
});

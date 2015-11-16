define(function(require) {
'use strict';

const { numericUidFromMessageId } = require('../../id_conversions');

const TaskDefiner = require('../../task_infra/task_definer');

return TaskDefiner.defineComplexTask([
  require('../../task_mixins/mix_download'),
  require('../task_mixins/imap_mix_download'),
  {
    getFolderAndUidForMesssage: function(ctx, account, message) {
      return Promise.resolve({
        folderInfo: account.getFirstFolderWithType('all'),
        uid: numericUidFromMessageId(message.id)
      });
    },
  }
]);
});

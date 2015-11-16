define(function(require) {
'use strict';

const { numericUidFromMessageId } = require('../../id_conversions');

const TaskDefiner = require('../../task_infra/task_definer');

return TaskDefiner.defineComplexTask([
  require('../../task_mixins/mix_sync_body'),
  require('../task_mixins/imap_mix_sync_body'),
  {
    prepForMessages: function(ctx, account/*, messages*/) {
      // For the gmail case we don't have any meaningful prep to do.
      let allMailFolderInfo = account.getFirstFolderWithType('all');
      return Promise.resolve(allMailFolderInfo);
    },

    getFolderAndUidForMesssage: function(prepped, account, message) {
      return {
        folderInfo: prepped,
        uid: numericUidFromMessageId(message.id)
      };
    }
  }
]);
});

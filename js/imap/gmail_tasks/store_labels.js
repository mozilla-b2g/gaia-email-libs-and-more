define(function(require) {
'use strict';

let co = require('co');

let TaskDefiner = require('../../task_definer');

let GmailLabelMapper = require('../gmail/gmail_label_mapper');

return TaskDefiner.defineComplexTask([
  require('./mix_store'),
  {
    name: 'store_labels',
    attrName: 'folderIds',
    // Note that we don't care about the read-back value.  Need to check if
    // this understands and honors a .SILENT suffix. TODO: check suffix.
    imapDataName: 'X-GM-LABELS',

    /**
     * Acquire a GmailLabelMapper for `normalizeLocalToServer`.
     */
    prepNormalizationLogic: co.wrap(function*(ctx, accountId) {
      let foldersTOC =
        yield ctx.universe.acquireAccountFoldersTOC(ctx, accountId);
      return new GmailLabelMapper(foldersTOC);
    }),

    /**
     * Transform FolderId values to GmailLabel values.  Used by the planning
     * stage as it crosses from the "do local things" to "schedule server
     * things" stage of things.
     */
    normalizeLocalToServer: function(labelMapper, folderIds) {
      // folderIds may be null, in which case we want to pass it through that
      // way.
      if (!folderIds) {
        return folderIds;
      }
      return labelMapper.folderIdsToLabels(folderIds);
    }
  }
]);

});

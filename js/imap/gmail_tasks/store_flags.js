define(function(require) {
'use strict';

let TaskDefiner = require('../../task_infra/task_definer');

return TaskDefiner.defineComplexTask([
  require('./mix_store'),
  {
    name: 'store_flags',
    attrName: 'flags',
    // We don't care about the fetch return, so don't bother.
    imapDataName: 'FLAGS.SILENT',

    prepNormalizationLogic: function(ctx, accountId) {
      return Promise.resolve(null);
    },

    normalizeLocalToServer: function(ignored, flags) {
      return flags;
    }
  }
]);

});

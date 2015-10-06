define(function(require) {
'use strict';

const TaskDefiner = require('../../task_infra/task_definer');

const { applyChanges } = require('../../delta_algebra');

/**
 * Planning-only task that applies modifications to a conversation based on
 * other sync logic.
 */
return TaskDefiner.defineSimpleTask([
  require('../../task_mixins/mix_sync_conv'),
  {
    name: 'sync_conv',

    applyChanges: function(message, flagChanges) {
      applyChanges(message.flags, flagChanges);
    },
  }
]);
});

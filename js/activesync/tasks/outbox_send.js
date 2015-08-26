define(function(require) {
'use strict';

const TaskDefiner = require('../../task_definer');

/**
 * ActiveSync is just the stock outbox-send logic because the server saves the
 * message into the sent folder for us automatically.
 */
return TaskDefiner.defineComplexTask([
  require('../../tasks/mix_outbox_send'),
  {
    shouldIncludeBcc: function(/* account */) {
      // ActiveSync auto-appends.
      return true;
    }
  }
]);
});

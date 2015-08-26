define(function(require) {
'use strict';

const TaskDefiner = require('../../task_definer');

/**
 * Gmail just uses the stock outbox send logic because gmail always
 * automatically puts a copy of the message in the sent folder for us.
 */
return TaskDefiner.defineComplexTask([
  require('../../tasks/mix_outbox_send'),
  {
    shouldIncludeBcc: function(/*account*/) {
      // Gmail automatically appends the sent message, so yes to BCC.
      return true;
    }
  }
]);
});

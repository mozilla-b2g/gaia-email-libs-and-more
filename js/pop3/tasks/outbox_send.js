define(function(require) {
'use strict';

const TaskDefiner = require('../../task_definer');

/**
 * POP3's custom logic is to:
 * - move the message into the (local-only) sent folder
 * - lose the attachments.
 *
 * TODO: in the future when the attachments use the download cache we can keep
 * them around.
 */
return TaskDefiner.defineComplexTask([
  require('../../tasks/mix_outbox_send'),
  {
    saveSentMessage: function() {

    }
  }
]);
});

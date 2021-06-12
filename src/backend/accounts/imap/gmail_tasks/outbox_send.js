import TaskDefiner from '../../../task_infra/task_definer';

import MixinOutboxSend from '../../../task_mixins/mix_outbox_send';

/**
 * Gmail just uses the stock outbox send logic because gmail always
 * automatically puts a copy of the message in the sent folder for us.
 */
export default TaskDefiner.defineComplexTask([
  MixinOutboxSend,
  {
    shouldIncludeBcc: function(/*account*/) {
      // Gmail automatically appends the sent message, so yes to BCC.
      return true;
    }
  }
]);

define(function(require) {
'use strict';

const co = require('co');
const { shallowClone } = require('../../util');

const { NOW } = require('../../date');

const TaskDefiner = require('../task_infra/task_definer');

/**
 * This task gathers up the new_tracking data from all accounts, feeds it to the
 * new_batch_churn, and sends the result over the wire to the frontend as a
 * broadcast.
 *
 * This task is automatically enqueued for scheduling when the root task group
 * of a task that modifies the newness state completes or when the new_tracking
 * state is explicitly cleared.  This means that this task happens magically
 * and you do not need to schedule it yourself.
 */
return TaskDefiner.defineAtMostOnceTask([
  {
    name: 'new_flush',
    // This will cause us to use the bin 'only' at all times.
    binByArg: null,

    /**
     * In our planning phase we discard nonsensical requests to refresh
     * local-only folders.
     */
    helped_plan: co.wrap(function*(ctx, rawTask) {

      return {
        taskState: null
      }
    },
  }
]);
});

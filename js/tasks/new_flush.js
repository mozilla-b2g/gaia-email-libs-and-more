define(function(require) {
'use strict';

const co = require('co');
const { shallowClone } = require('../../util');

const { NOW } = require('../../date');

const TaskDefiner = require('../task_infra/task_definer');

const churnAllNewMessages = require('app_logic/new_batch_churn');

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
     *
     */
    helped_plan: co.wrap(function*(ctx, rawTask) {
      // -- Get the list of all accounts

      // -- For each account, consult the new_tracking task

      // -- Have the app logic churn

      // -- Send the batch
      yield null;

      return {
        taskState: null
      }
    }),
  }
]);
});

define(function(require) {
'use strict';

const co = require('co');
const mix = require('mix');
const { shallowClone } = require('../util');

const AtMostOnceBase = require('./task_bases/at_most_once');

//const AtMostOnceTaskBase = require('./task_bases/at_most_once');

const SimpleTaskBase = {
  isSimple: true,
  isComplex: false,

  /**
   * No-op planning phase that just handles prioritization.
   */
  plan: co.wrap(function*(ctx, rawTask) {
    let decoratedTask = shallowClone(rawTask);
    if (this.exclusiveResources) {
      decoratedTask.exclusiveResources = this.exclusiveResources(rawTask);
    }
    if (this.priorityTags) {
      decoratedTask.priorityTags = this.priorityTags(rawTask);
    }
    yield ctx.finishTask({
      taskState: decoratedTask
    });
  }),
  execute: null,
};

const ComplexTaskBase = {
  isSimple: false,
  isComplex: true,
};

/**
 * Given a base implementation and one or more mix-in parts from the task that
 * is being defined, collapse the `mixparts` down, giving the task base a chance
 * to
 */
function mixInvokingBaseHooks(baseImpl, mixparts) {
  // If the base doesn't care, just do the naive mixing.
  if (!baseImpl.__preMix && !baseImpl.__postMix) {
    return Object.assign({}, baseImpl, ...mixparts);
  }
  let target = Object.assign({}, baseImpl);
  let coalescedParts = Object.assign({}, ...mixparts);
  if (target.__preMix) {
    target.__preMix(coalescedParts);
  }
  Object.assign(target, coalescedParts);
  if (target.__postMix) {
    target.__postMix();
  }
  return target;
}

/**
 * Singleton support logic
 */
function TaskDefiner() {
}
TaskDefiner.prototype = {
  /**
   * Define a task that's fully characterized by its name an arguments and along
   * with some other simple configuration, the task infrastructure is able to
   * handle all the state management.
   */
  defineSimpleTask: function(mixparts) {
    return mixInvokingBaseHooks(SimpleTaskBase, mixparts);
  },

  /**
   * Define a task that that only makes sense to have at most one task queued/
   * active for a given set of arguments at a time.  For example, since sync
   * tasks should usually bring us up-to-date with "now" when they run, letting
   * the UI queue up a bunch of them in a row is potentially very wasteful.
   *
   * We wrap the task into a complex task, but the task is largely able to
   * pretend that it is a simple task.  The task definition's `binByArgs`
   * indicate what arguments we should use to bin/uniquely group the tasks by.
   *
   * A new task covered by an existing task/marker will be currently be dropped.
   * TODO: Do root cause magic to handle this scenario better.
   */
  defineAtMostOnceTask: function(mixparts) {
    return mixInvokingBaseHooks(AtMostOnceBase, mixparts);
  },

  /**
   * Define a task that maintains its own aggregate state and handles all task
   * mooting, unification, etc.
   */
  defineComplexTask: function(mixparts) {
    return mixInvokingBaseHooks(ComplexTaskBase, mixparts);
  }
};

return new TaskDefiner();
});

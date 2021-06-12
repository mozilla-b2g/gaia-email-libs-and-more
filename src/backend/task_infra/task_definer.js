import { shallowClone } from 'shared/util';

import AtMostOnceBase from './task_bases/at_most_once';

const SimpleTaskBase = {
  isSimple: true,
  isComplex: false,

  /**
   * No-op planning phase that just handles prioritization.
   */
  async plan(ctx, rawTask) {
    let decoratedTask = shallowClone(rawTask);
    if (this.exclusiveResources) {
      decoratedTask.exclusiveResources = this.exclusiveResources(rawTask);
    }
    if (this.priorityTags) {
      decoratedTask.priorityTags = this.priorityTags(rawTask);
    }
    await ctx.finishTask({
      taskState: decoratedTask
    });
  },
  execute: null,
};

const ComplexTaskBase = {
  isSimple: false,
  isComplex: true,
};

/**
 * Given a base implementation and one or more mix-in parts from the task that
 * is being defined, collapse the `mixparts` down, giving the task base a chance
 * to participate via hooks.
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
 * Singleton support logic.
 *
 * Note that this doesn't want to be directly exported; we export a singleton
 * instance of this class.
 */
function TaskDefiner() {
}
TaskDefiner.prototype = {
  /**
   * Define a task that's fully characterized by its name an arguments and along
   * with some other simple configuration, the task infrastructure is able to
   * handle all the state management.
   */
  defineSimpleTask(mixparts) {
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
   *
   * - helped_overlay_NAMESPACE(binId, marker, inProgress): A naming pattern
   *   that allows definining one or more overlay functions where support logic
   *   will lookup the current marker and whether it's in progress (or is
   *   being treated as in-progress because `remainInProgressUntil` was used in
   *   helped_plan).  The function should return its contribution to the overlay
   *   value for the item, or null if it has no contribution.
   * - helped_prefix_overlay_NAMESPACE: Like the non-prefix version, but that
   *   version assumes the overlay id is the same as the bin id.  In this case,
   *   instead of providing a function, you provide a 2-element list where the
   *   first function extracts the binId to use from the overlay id, and the
   *   second function has the same signature as that of the non-prefix case.
   * - helped_plan: The returned value is passed to finishTask.  We also
   *   introduce the following values that can be included for extra semantics:
   *   - `result`: The value to return from the actual `plan` implementation.
   *   - `announceUpdatedOverlayData`: A list of [namespace, id] values like
   *     one would manually invoke via ctx.announceUpdatedOverlayData(namespace,
   *     id).  Because the relevant data structures are not updated until your
   *     generator returns, directly invoking those methods would not do what
   *     you expect.
   *   - `remainInProgressUntil`: If a promise is provided, we will report this
   *     bin as `inProgress` to your overlay helpers even after the execute
   *     phase has concluded.  The expected idiom is to use this in cases like
   *     "sync_refresh" where a task group is created via
   *     `ctx.trackMeInTaskGroup` (which returns a promise), so that the task
   *     can claim to be in progress until all its spin-off tasks have
   *     completed.  It could make sense for this to be supported in the execute
   *     case as well, but we're avoiding that complexity for now.
   * - helped_already_planned: Optional method to be invoked when we've
   *   determined there's already a marker in place for the given bin.  Intended
   *   to be used to return a Promise created via `ctx.trackMeInTaskGroup` so
   *   things like refresh requests can be consolidated while still having
   *   useful promises returned.
   * - helped_invalidate_overlays(binId): Optional, but required if
   *   `remainInProgressUntil` is provided.  Very useful for avoiding tons of
   *   redundant-ish data overlay invalidation calls.  Invoked when:
   *   - Planning completes.
   *   - Execution is starting.
   *   - Execution completes.
   *   - The `remainInProgressUntil` resolves, and after we have removed the
   *     state that caused our overlay implementations to claim the bin was
   *     still `inProgress`.
   */
  defineAtMostOnceTask(mixparts) {
    return mixInvokingBaseHooks(AtMostOnceBase, mixparts);
  },

  /**
   * Define a task that maintains its own aggregate state and handles all task
   * mooting, unification, etc.
   */
  defineComplexTask(mixparts) {
    return mixInvokingBaseHooks(ComplexTaskBase, mixparts);
  }
};

export default new TaskDefiner();

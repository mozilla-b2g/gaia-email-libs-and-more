define(function() {
'use strict';

/**
 * Tracks groups of one or more tasks and their spinoff tasks to provide higher
 * level completion notifications for users and so the `BatchManager` can flush
 * as early as possible without hand-waving timeout constants.
 *
 * We structure our tasks to be as small and as atomic as possible, which means
 * that they also are not a good level of granularity for higher level tasks.
 * For example, the core "sync_refresh" task does nothing directly, it is the
 * spun-off tasks that takes user-perceptible actions.  Which is where task
 * groups come in.
 *
 * Tasks are responsible for their own task group management.  This is ideal
 * because tasks are also responsible for consolidating redundant requests,
 * meaning they can also reuse existing task groups.  Additionally, since tasks
 * also manage overlays, this lets tasks like "sync_refresh" continue to expose
 * overlay state until the rest of the group completes.
 *
 * There are use-cases where it's handy for a task group to effectively contain
 * other groups.  Since the task-begets-task graph is a tree, we can easily
 * accomplish this by having groups be aware of their parent groups
 */
function TaskGroupTracker(taskManager) {
  this._groupsByName = new Map();
  this._taskIdsToGroups = new Map();
  // All task id's in this set are a case of a simple task reusing its id and
  // where we have heard the willExecute for the id but have not yet heard the
  // planned for the id.  We add the id here in `willExecute` and remove it in
  // `planned`, skipping the rest of our usual logic in `planned`.
  this._pendingTaskIdReuses = new Set();

  this.__registerListeners(taskManager);
}
TaskGroupTracker.prototype = {
  __registerListeners: function(emitter) {
    emitter.on('willPlan', this, this._onWillPlan);
    emitter.on('willExecute', this, this._onWillExecute);
    emitter.on('planned', this, this._onPlanned);
    emitter.on('executed', this, this._onExecuted);
  },

  /**
   * Ensure that a task group exists with the given name, and return a Promise
   * that will be resolved when the last task in the group completes.
   */
  ensureNamedTaskGroup: function(groupName, taskId) {
    let group = this._groupsByName.get(groupName);
    if (!group) {
      group = this._makeTaskGroup(groupName);
    }

    let existingOwningGroup = this._taskIdsToGroups.get(taskId);
    // It's possible the group already existed and we were already mapped into
    // the group.  (It's also possible the group existed but we weren't mapped
    // in.)
    if (existingOwningGroup !== group) {
      group.parentGroup = existingOwningGroup;
      // our group is assuming the pendingCount of the task.
    }
    group.pendingCount++;
    this._taskIdsToGroups.set(taskId, group);
    return group.promise;
  },

  _makeTaskGroup: function(groupName) {
    let group = {
      groupName,
      // The number of tasks or groups that have yet to complete.
      pendingCount: 0,
      parentGroup: null,
      promise: null,
      resolve: null
    };
    group.promise = new Promise((resolve) => {
      group.resolve = resolve;
    });
    this._groupsByName.set(groupName, group);
    return group;
  },

  /**
   * The TaskManager tells us about every raw task enqueued for planning, and
   * we use that to learn about new tasks spun-off by existing tasks so that
   * we can add them to the parent's group.
   */
  _onWillPlan: function(taskThing, sourceId) {
    // No sourceId means there's no group membership to propagate.
    if (!sourceId) {
      return;
    }
    let sourceGroup = this._taskIdsToGroups.get(sourceId);
    if (sourceGroup) {
      sourceGroup.pendingCount++;
      this._taskIdsToGroups.set(taskThing.id, sourceGroup);
    }
  },

  /**
   * The task tells us about every planned task or task marker queued for
   * execution.  We use that to propagate group membership.
   */
  _onWillExecute: function(taskThing, sourceId) {
    // No sourceId means there's no group membership to propagate.
    if (!sourceId) {
      return;
    }
    let sourceGroup = this._taskIdsToGroups.get(sourceId);
    if (sourceGroup) {
      // If the sourceId is the same as the task's id then this is a simple task
      // reusing the id, and it gets specialized.  We do this checking inside
      // the conditional somewhat arbitrarily; it just makes more sense for us
      // to only track the id if we already care and presumably would be less
      // confusing in the debugger.
      if (sourceId === taskThing.id) {
        this._pendingTaskIdReuses.add(sourceId);
      }
      sourceGroup.pendingCount++;
      this._taskIdsToGroups.set(taskThing.id, sourceGroup);
    }
  },

  _decrementGroupPendingCount(group) {
    if (--group.pendingCount === 0) {
      group.resolve();
      this._groupsByName.delete(group.groupName);
      if (group.parentGroup) {
        this._decrementGroupPendingCount(group.parentGroup);
      }
    }
  },

  _onPlanned: function(taskId) {
    // Other side of our willExecute specialization for the simple task that is
    // completing planning.  Skip out since we just directly propagated its
    // pendingCount.
    if (this._pendingTaskIdReuses.has(taskId)) {
      this._pendingTaskIdReuses.delete(taskId);
      return;
    }
    let group = this._taskIdsToGroups.get(taskId);
    if (group) {
      this._taskIdsToGroups.delete(taskId);
      this._decrementGroupPendingCount(group);
    }
  },

  _onExecuted: function(taskId) {
    let group = this._taskIdsToGroups.get(taskId);
    if (group) {
      this._taskIdsToGroups.delete(taskId);
      this._decrementGroupPendingCount(group);
    }
  }
};
});

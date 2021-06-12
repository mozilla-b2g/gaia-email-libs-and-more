import logic from 'logic';

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
export default function TaskGroupTracker(taskManager) {
  logic.defineScope(this, 'TaskGroupTracker');

  this.taskManager = taskManager;

  /**
   * Uniqueifying id helper so we can differentiate group "instances".  While
   * it's great that we can use semantic names like "sync_refresh:2" for when
   * we're syncing account 2, it's also useful to be able to distinguish one
   * aggregated sync effort from one that happens later.  We use the group id's
   * to this end.  We assume and require that group id's will only be compared
   * within a single universe lifetime with any comparisons being "!==" tests
   * initialized to null on each reset so this does not pose a problem.
   */
  this._nextGroupId = 1;
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
  __registerListeners(emitter) {
    emitter.on('willPlan', this, this._onWillPlan);
    emitter.on('willExecute', this, this._onWillExecute);
    emitter.on('planned', this, this._onPlanned);
    emitter.on('executed', this, this._onExecuted);
  },

  // Internal heart of ensureNamedTaskGroup that exposes internal rep for reuse
  // by other class code.
  _ensureNamedTaskGroup(groupName, taskId) {
    let group = this._groupsByName.get(groupName);
    if (!group) {
      group = this._makeTaskGroup(groupName);
      logic(this, 'createGroup', { groupName, taskId });
    } else {
      logic(this, 'reuseGroup', { groupName, taskId });
    }

    // (normalize to null from undefined)
    let existingOwningGroup = this._taskIdsToGroups.get(taskId) || null;
    // It's possible the group already existed and we were already mapped into
    // the group.  (It's also possible the group existed but we weren't mapped
    // in.)
    if (existingOwningGroup !== group) {
      group.parentGroup = existingOwningGroup;
      // our group is assuming the pendingCount of the task.
    }
    group.pendingCount++;
    group.totalCount++;
    this._taskIdsToGroups.set(taskId, group);
    return group;
  },

  /**
   * Ensure that a task group exists with the given name, and return a Promise
   * that will be resolved when the last task in the group completes.
   */
   ensureNamedTaskGroup(groupName, taskId) {
     let group = this._ensureNamedTaskGroup(groupName, taskId);
     return group.promise;
   },

  /**
   * Return the root ancestor task group.  See TaskContext.rootTaskGroupId for
   * the rationale for this existing.
   */
  getRootTaskGroupForTask(taskId) {
    let taskGroup = this._taskIdsToGroups.get(taskId);
    if (!taskGroup) {
      return taskGroup;
    }
    while (taskGroup.parentGroup !== null) {
      taskGroup = taskGroup.parentGroup;
    }
    return taskGroup;
  },

  ensureRootTaskGroupFollowOnTask(taskId, taskToPlan) {
    let rootTaskGroup = this.getRootTaskGroupForTask(taskId);
    if (!rootTaskGroup) {
      // Create a group for the task if one didn't exist.
      rootTaskGroup =
        this._ensureNamedTaskGroup('ensured:' + this._nextGroupId, taskId);
    }
    if (!rootTaskGroup.tasksToScheduleOnCompletion) {
      rootTaskGroup.tasksToScheduleOnCompletion = new Set();
    }
    rootTaskGroup.tasksToScheduleOnCompletion.add(taskToPlan);
  },

  _makeTaskGroup(groupName) {
    let group = {
      groupName,
      // (see the comment for _nextGroupId for rationale on this)
      groupId: this._nextGroupId++,
      // The number of tasks or groups that have yet to complete.
      pendingCount: 0,
      // Debugging support: track the number of things this group ever wanted to
      // wait on.
      totalCount: 0,
      parentGroup: null,
      promise: null,
      resolve: null,
      tasksToScheduleOnCompletion: null,
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
  _onWillPlan(taskThing, sourceId) {
    // No sourceId means there's no group membership to propagate.
    if (!sourceId) {
      return;
    }
    let sourceGroup = this._taskIdsToGroups.get(sourceId);
    if (sourceGroup) {
      sourceGroup.pendingCount++;
      sourceGroup.totalCount++;
      this._taskIdsToGroups.set(taskThing.id, sourceGroup);
    }
  },

  /**
   * The task tells us about every planned task or task marker queued for
   * execution.  We use that to propagate group membership.
   */
  _onWillExecute(taskThing, sourceId) {
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
        // And we don't bump the pending count because we fast-path out when we
        // see the above set entry.
      } else {
        sourceGroup.pendingCount++;
      }
      sourceGroup.totalCount++;
      this._taskIdsToGroups.set(taskThing.id, sourceGroup);
    }
  },

  _decrementGroupPendingCount(group) {
    if (--group.pendingCount === 0) {
      logic(
        this, 'resolveGroup',
        {
          groupName: group.groupName,
          totalCount: group.totalCount
        });
      group.resolve();
      this._groupsByName.delete(group.groupName);
      if (group.tasksToScheduleOnCompletion) {
        this.taskManager.scheduleTasks(
          Array.from(group.tasksToScheduleOnCompletion),
          'deferred-group:' + group.groupName);
      }
      if (group.parentGroup) {
        this._decrementGroupPendingCount(group.parentGroup);
      }
    }
  },

  _onPlanned(taskId) {
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

  _onExecuted(taskId) {
    let group = this._taskIdsToGroups.get(taskId);
    if (group) {
      this._taskIdsToGroups.delete(taskId);
      this._decrementGroupPendingCount(group);
    }
  }
};

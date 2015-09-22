define(function(require) {
'use strict';

const logic = require('logic');

/**
 * Helper class for use by TaskManager that is in charge of tracking the
 * resource-related issues.  This code exists to try and avoid TaskManager
 * becoming horribly complicated, but there is inherently some coupling.
 *
 * TODO: Implement exclusive resource support or remove all traces of that.
 */
function TaskResources(priorities) {
  logic.defineScope(this, 'TaskResources');

  this._priorities = priorities;

  /**
   * The set of currently available resources.
   */
  this._availableResources = new Set();

  /**
   * @type {Map<ResourceId, TaskThing[]>}
   */
  this._blockedTasksByResource = new Map();

  /**
   * The set of currently blocked tasks.
   */
  this._blockedTasksById = new Map();
}
TaskResources.prototype = {
  /**
   * Tells us that a resource is available, allowing us to potentially unblock
   * blocked tasks.  If anything was blocked, we call `ownOrRelayTaskThing` for
   * each TaskThing.  If there is still something blocking the task, it will
   * get filed as blocked under that resourceId.  If there is nothing blocking
   * it anymore, it will be handed over to `TaskPriorities` for prioritization.
   *
   * (Note that this means that tasks with multiple resources may end up in
   * any of the blocked lists.  There is no equivalent to mutex locking
   * discipline happening here.)
   *
   * Note that it's assumed our caller is the TaskManager and it will take care
   * of calling _maybeDoStuff to ensure it starts processing things if relevant.
   *
   * @return {Number}
   *   The number of tasks prioritized as a result of the resouce being made
   *   available.
   */
  resourceAvailable: function(resourceId) {
    logic(this, 'resourceAvailable', { resourceId });
    this._availableResources.add(resourceId);

    if (!this._blockedTasksByResource.has(resource)) {
      return 0;
    }

    let taskThings = this._blockedTasksByResource.get(resourceId);
    this._blockedTasksByResource.delete(resourceId);

    let prioritized = 0;
    for (let taskThing of taskThings) {
      this._blockedTasksById.delete(taskThing.id);
      if (this.ownOrRelayTaskThing(taskThing)) {
        prioritized++;
      }
    }

    return prioritized;
  },

  /**
   * Tells us that a resource is now gone, which means that we may potentially
   * need to block a ton of tasks.
   *
   * Because we aren't expecting resource transitions to happen all that
   * frequently and we expect the number of outstanding tasks to be rather low,
   * we traverse all currently prioritized resources using a helper provided by
   * TaskPriorities.  (Note that this is in contrast to priorityTags, which
   * we do expect to change at higher rates and during high levels of task
   * churn.)
   */
  resourceNoLongerAvailable: function(resourceId) {
    logic(this, 'resourceNoLongerAvailable', { resourceId });
  },

  /**
   * Block the task if it doesn't have all the resources it needs, otherwise
   * hand it off to TaskPriorities for immediate prioritization.
   *
   * @return {Boolean}
   *   We return true if we passed the TaskThing through to prioritization and
   *   so there is potentially new work to do.
   */
  ownOrRelayTaskThing: function(taskThing) {
    // If we're already aware of this task id and this is an update, then first
    // let's remove the task so we don't have to deal with edge-cases below.
    if (this._blockedTasksById.has(taskThing.id)) {
      this.removeTaskThing(taskThing.id);
    }

    if (taskThing.resources) {
      for (let resourceId of taskThing.resources) {
        if (!this._availableResources.has(resourceId)) {
          // Since we're going to make this block, and as alluded to above,
          // task markers can get updated, make sure to tell the priorities
          // implementation to forget about this task if it knows about its
          // previous incarnation.  (We didn't do it above because in the
          // event we don't block it, TaskPriorities is smart enough to
          // efficiently update in place.)
          this._priorities.removeTaskThing(taskThing.id);

          logic(this, 'taskBlockedOnResource',
                { taskId: taskThing.id, resourceId });
          this._blockedTasksById.set(taskThing.id, taskThing);
          if (this._blockedTasksByResource.has(resourceId)) {
            this._blockedTasksByResource.get(resourceId).push(taskThing);
          } else {
            this._blockedTasksByResource.set(resourceId, [taskThing]);
          }
          return false;
        }
      }
    }

    this._priorities.prioritizeTaskThing(taskThing);
    return true;
  },

  removeTaskThing: function(taskId) {
    if (!this._blockedTasksById.has(taskId)) {
      this._priorities.removeTaskThing(taskId);
      return;
    }

    let taskThing = this._blockedTasksById.get(taskId);
    this._blockedTasksById.delete(taskId);
    for (let [resourceId, blockedThings] of this._blockedTasksByResource) {
      let idx = blockedThings.indexOf(taskThing);
      if (idx === -1) {
        continue;
      }

      blockedThings.splice(idx, 1);
      if (blockedThings.length === 0) {
        this._blockedTasksByResource.delete(resourceId);
      }

      break;
    }
  },


};
return TaskResources;
});

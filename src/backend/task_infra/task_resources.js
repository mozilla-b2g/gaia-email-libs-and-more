import logic from 'logic';

/**
 * Helper class for use by TaskManager that is in charge of tracking the
 * resource-related issues.  This code exists to try and avoid TaskManager
 * becoming horribly complicated, but there is inherently some coupling.
 *
 * TODO: Implement exclusive resource support or remove all traces of that.
 */
export default function TaskResources(priorities) {
  logic.defineScope(this, 'TaskResources');

  this._priorities = priorities;

  /**
   * The set of currently available resources.
   */
  this._availableResources = new Set();

  /**
   * @type {Map<ResourceId, TaskThing[]>}
   *
   * Tracks tasks blocked on the given resouce.
   */
  this._blockedTasksByResource = new Map();

  /**
   * @type{Map<TaskId, TaskThing>}
   *
   * A map of blocked TaskThings with their TaskId as the key.
   */
  this._blockedTasksById = new Map();

  /**
   * @type{Map<ResourceId, TimerId>}
   */
  this._resourceTimeouts = new Map();
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
  resourceAvailable(resourceId) {
    // bail if the resource is already available; no changes.
    if (this._availableResources.has(resourceId)) {
      logic(this, 'resourceAlreadyAvailable', { resourceId });
      return 0;
    }

    logic(this, 'resourceAvailable', { resourceId });
    this._availableResources.add(resourceId);

    this._clearResourceTimeouts(resourceId);

    if (!this._blockedTasksByResource.has(resourceId)) {
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
   * Tells us that one or more resources are now gone, which means that we may
   * potentially need to block a ton of tasks.
   *
   * Because we aren't expecting resource transitions to happen all that
   * frequently and we expect the number of outstanding tasks to be rather low,
   * we traverse all currently prioritized resources using a helper provided by
   * TaskPriorities.  (Note that this is in contrast to priorityTags, which
   * we do expect to change at higher rates and during high levels of task
   * churn.)
   */
  resourcesNoLongerAvailable(removedResourceIds) {
    // - Remove the resources
    let removedCount = 0;
    for (let removedResourceId of removedResourceIds) {
      if (this._availableResources.has(removedResourceId)) {
        this._availableResources.delete(removedResourceId);
        removedCount++;
      }
    }

    if (removedCount === 0) {
      logic(this, 'resourcesAlreadyUnavailable', { removedResourceIds });
      return;
    }

    logic(this, 'resourcesNoLongerAvailable', { removedResourceIds });

    // - Remove already-prioritized tasks that depend on these resources
    const nowBlocked = [];
    this._priorities.removeTasksUsingFilter((taskThing) => {
      // If the thing has resources at all and one of those resources is one we
      // just removed, then tell priorities to stop tracking it.
      if (taskThing.resources) {
        for (let resourceId of taskThing.resources) {
          if (removedResourceIds.indexOf(resourceId) !== -1) {
            nowBlocked.push(taskThing);
            return true; // (do remove)
          }
        }
      }
      return false;
    });

    // - Reschedule all of these blocked tasks
    // (We know they will end up blocked rather than re-prioritized because we
    // removed one of the resources they depend on above.)
    for (let taskThing of nowBlocked) {
      this.ownOrRelayTaskThing(taskThing);
    }
  },

  /**
   * Shared helper for resourceAvailable and restoreResourceAfterTimeout to
   * clear a pending timeout request issued by restoreResourceAfterTimeout.
   */
  _clearResourceTimeouts(resourceId) {
    if (this._resourceTimeouts.has(resourceId)) {
      clearTimeout(this._resourceTimeouts.get(resourceId));
      this._resourceTimeouts.delete(resourceId);
    }
  },

  /**
   * Automatically re-add the given resourceId after timeoutMillis milliseconds.
   * This is expected to be used in conjunction with resourceNoLongerAvailable
   * to implement simple back-off based retry mechanisms.
   *
   * If the resource is explicitly added via resourceAvailable, then this
   * timeout will automatically be cleared.
   */
  restoreResourceAfterTimeout(resourceId, timeoutMillis) {
    this._clearResourceTimeouts();
    let timeoutId = setTimeout(
      () => { this.resourceAvailable(resourceId); }, timeoutMillis);
    this._resourceTimeouts.set(resourceId, timeoutId);
  },

  /**
   * Given a task id, if it is blocked, return the list of resources it requires
   * that are not currently available, otherwise returns null.  The resources
   * are returned in the order that they are listed on the taskThing, so if the
   * task orders them with some meaning, it can leverage this to easily
   * determine the most significant missing resource, etc.
   */
  whatIsTaskBlockedBy(taskId) {
    const taskThing = this._blockedTasksById.get(taskId);
    if (!taskThing) {
      return null;
    }
    // (we are blocked by something if we're here)

    const blockedBy = [];
    for (let resource of taskThing.resources) {
      if (!this._availableResources.has(resource)) {
        blockedBy.push(resource);
      }
    }
    return blockedBy;
  },

  /**
   * Block the task if it doesn't have all the resources it needs, otherwise
   * hand it off to TaskPriorities for immediate prioritization.
   *
   * @return {Boolean}
   *   We return true if we passed the TaskThing through to prioritization and
   *   so there is potentially new work to do.
   */
  ownOrRelayTaskThing(taskThing) {
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

  removeTaskThing(taskId) {
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


define(function (require) {
'use strict';

let logic = require('logic');

/**
 * Provides helpers and standard arguments/context for tasks.
 */
function TaskContext(taskThing, universe) {
  // We are used as the scope for all logging by the task, so just call
  // ourselves "Task".
  logic.defineScope(this, 'Task', { id: taskThing.id });
  this.id = taskThing.id;
  this.isTask = !taskThing.type; // it's a TaskMarker if the type is on the root
  this._taskThing = taskThing;
  this.universe = universe;

  this._stuffToRelease = [];
  this._preMutateStates = null;

  /**
   * @type {'prep'|'mutate'|'finishing'}
   */
   this.state = 'prep';
}
TaskContext.prototype = {
  get taskMode() {
    if (!this.isTask) {
      return 'executing'; // task marker => we're executing
    } else if (this._wrappedTask.state === null) {
      return 'planning';
    } else {
      return 'executing';
    }
  },

  /**
   * Return the type of the task.
   */
  get taskType() {
    if (this.isTask) {
      // (the task is being planned)
      if (this._taskThing.state === null) {
        return this._taskThing.rawTask.type;
      }
      // (the task is being executed)
      else {
        return this._taskThing.plannedTask.type;
      }
    }
    // It's a task marker
    else {
      return this._taskThing.type;
    }
  },

  /**
   * Return the account id this task is associated with.  It's possible for this
   * to be null for global tasks.
   */
  get accountId() {
    if (this.isTask) {
      // (the task is being planned)
      if (this._taskThing.state === null) {
        return this._taskThing.rawTask.accountId || null;
      }
      // (the task is being executed)
      else {
        return this._taskThing.plannedTask.accountId || null;
      }
    }
    // It's a task marker
    else {
      return this._taskThing.accountId || null;
    }
  },

  // Convenience helpers to help us get at these without redundantly storing.
  // Underscored since tasks should not be directly accessing these on their
  // own.  Instead they should be using helpers on this object.
  get _taskManager() {
    return this.universe.taskManager;
  },
  get _taskRegistry() {
    return this.universe.taskRegistry;
  },

  /**
   * Asynchronously acquire a resource and track that we are using it so that
   * when the task completes or is terminated we can automatically release all
   * acquired resources.
   */
  acquire: function(acquireable) {
    this._stuffToRelease.push(acquireable);
    return acquireable.__acquire(this);
  },

  _releaseEverything: function() {
    for (let acquireable of this._stuffToRelease) {
      try {
        acquireable.__release(this);
      } catch (ex) {
        logic(this, 'problem releasing', { what: acquireable, ex: ex });
      }
    }
  },

  /**
   * Synchronously ask a (complex) task implementation something.  This is
   * primarily intended for situations where a task that is synchronizing with
   * a server needs to compensate for offline operations that have not yet been
   * played against the server.  For example synchronizing messages needs to
   * compensate for manipulations of flags and labels not yet told to the
   * server.
   *
   * Note that this could alternately have been addressed by ensuring that
   * offline operations are run against the server in a strict order that avoids
   * this, it's arguably simpler to reason about things this way.  The downside,
   * of course, is that logic that fails to consult other tasks potentially runs
   * into trouble.  However, synchronization logic is tightly coupled and it's
   * hard to avoid that.
   *
   * @param {Object} consultWhat
   *   Characterizes the task we want to talk to.
   * @param {AccountId} accountId
   * @param {String} name
   *   The task name.
   * @param {Object} argDict
   *   The argument object to be passed to the complex task.
   */
  synchronouslyConsultOtherTask: function(consultWhat, argDict) {
    this._taskRegistry.__synchronouslyConsultOtherTask(
      this, consultWhat, argDict);
  },

  /**
   * In the event our task throws an error, we want you to plan the tasks we
   * pass in now in order to repair our state.  This should be used in those
   * cases where a complex task is altering its in-memory aggregated state
   * during the execute() phase and new plan() calls when executed in parallel
   * may accumulate additional state into the complex state that is not easily
   * reconciled.  (If it is easily reconciled, the complex task can just wrap
   * everything in a try/catch and put stuff back in in the catch.)
   *
   * The goal here is to avoid having already complex tasks grow even more
   * complex with a try/catch with a lot of complexity.
   *
   * In the case a planning task is executed for the complex task, these given
   * tasks would want to be spilled to disk as part of the commit for that
   * complex task to handle the crash case.  And this task context would then
   * want to automatically augment its commit to nuke those tasks from disk upon
   * successful completion.
   *
   * TODO: implement this
   * TODO: think more on also having a variant of this where we issue the
   * defensive commit immediately (with durability) for those cases where it
   * is essential that we 100% know if we attempted to do something rather than
   * just tracking the "maybe we started this".  Alternately, maybe that's
   * silly and if we're needing to do that we should just break the task up
   * into distinct sub-tasks.
   */
  setFailureTasks: function(tasks) {

  },

  /**
   * Called by a task to indicate that it's still alive.
   *
   * Currently used for:
   * - renewing the wakelocks we keep active for the task.
   * Probably will be used for:
   * - a similar set of timeouts we use to figure when a task has died in a way
   *   that didn't lead to a rejection we got to see.  In that case we try and
   *   kill the task and cleanup.
   *
   * It might be better if instead we just had the tasks return a promise that
   * also generates progress information and/or let additional progress promises
   * (or streams?) exist.  But in general our needs are somewhat limited and
   * we can probably just have the connections tell us when they're trafficking
   * in data.
   */
  heartbeat: function(/* why */) {
    this._taskManager.__renewWakeLock();
  },

  read: function(what) {
    return this.universe.db.read(this, what);
  },

  beginMutate: function(what) {
    if (this.state !== 'prep') {
      throw new Error(
        'Cannot switch to mutate state from state: ' + this.state);
    }
    this.state = 'mutate';
    return this.universe.db.beginMutate(this, what);
  },

  /**
   * Acquire more stuff for mutation.  Using this is not a good sign.  When we
   * go parallel and the locking mechanism happens, we would ideally be rid of
   * this.  However, for the parallel work with our goal of never delaying
   * local/planning operations, we'll probably already be splitting many
   * mutate calls into a read followed by online action followed by mutate
   * exclusive acquisition.
   *
   * Usage wise right now we've got:
   * - ActiveSync's sync_body implementation that needs this for v2.5 support
   *   because I'm trying to reuse the mix-in IMAP uses.  Using this could
   *   be avoided by some refactoring or giving ActiveSync its own full
   *   implementation.
   */
  mutateMore: function(what) {
    if (this.state !== 'mutate') {
      throw new Error(
        'You should already be mutating, not in state: ' + this.state);
    }
    return this.universe.db.beginMutate(this, what);
  },

  /**
   *
   */
  dangerousIncrementalWrite: function(mutations) {
    return this.universe.db.dangerousIncrementalWrite(this, mutations);
  },

  /**
   * @param {Object} finishData
   * @param {Object} finishData.mutations
   *   The mutations to finish as a result of the one preceding call to
   *   `beginMutate`.
   * @param {Object} finishData.newData
   *   New records being added to the database.
   * @param {Array<RawTask>} finishData.newData.tasks
   *   The new tasks that should be atomically, persistently tracked as a
   *   deterministic result of this task.
   * @param {Object} [finishData.taskState]
   *   The new state for the task.  Until complex tasks are implemented, this
   *   should always be a real object.  But omit/just pass null if you want
   *   your task no longer tracked because you turn out to be moot, etc.  This
   *   is ignored if the task is in the execute state because the task is
   *   considered concluded for now.  XXX in the future, we will let tasks
   *   re-queue themselves, etc. as part of the error handling logic.
   * @param {Object} [finishData.complexTaskState]
   *   Syntactic sugar for a complex task that wants to update its aggregate
   *   task state.  `finishData.mutations.complexTaskStates` should be used
   *   directly if the data is divided up further.  (And if the state lives
   *   elsewhere in the database, that should be used.)
   * @param {TaskMarker[]} [finishData.taskMarkers]
   *   Task markers (for complex tasks), analogous to planned tasks for
   *   scheduling/prioritization purposes.  It's not under `newData` like
   *   `newData.tasks` because these are not directly pesisted.
   */
  finishTask: function(finishData) {
    if (this.state === 'finishing') {
      throw new Error('already finishing! did you put finishTask in a loop?');
    }
    this.state = 'finishing';

    let revisedTaskInfo;
    if (this.isTask) {
      if (finishData.taskState) {
        // (Either this was the planning stage or an execution stage that didn't
        // actually complete; we're still planned either way.)
        this._taskThing.state = 'planned';
        this._taskThing.plannedTask = finishData.taskState;
        revisedTaskInfo = {
          id: this.id,
          value: this._taskThing
        };
        this.universe.taskManager.__queueTasksOrMarkers(
          [this._taskThing], this.id, true);
      } else {
        revisedTaskInfo = {
          id: this.id,
          value: null
        };
      }
    }

    // - Complex Task State
    // Apply the helpful record aliasing that task_registry understands.
    if (finishData.complexTaskState) {
      if (!finishData.mutations) {
        finishData.mutations = {};
      }
      finishData.mutations.complexTaskStates =
        new Map([[[this.accountId, this.taskType],
                  finishData.complexTaskState]]);
    }

    // (Complex) task markers can be immediately prioritized.
    if (finishData.taskMarkers) {
      for (let [markerId, taskMarker] of finishData.taskMarkers) {
        // create / update marker
        if (taskMarker) {
          this.universe.taskManager.__queueTasksOrMarkers(
            [taskMarker], this.id, true);
        }
        // nuke the marker
        else {
          this.universe.taskManager.__removeTaskOrMarker(markerId);
        }
      }
    }

    // Normalize any tasks that should be byproducts of this task.
    let wrappedTasks = null;
    if (finishData.newData && finishData.newData.tasks) {
      wrappedTasks =
        this.universe.taskManager.__wrapTasks(finishData.newData.tasks);
    }

    return this.universe.db.finishMutate(
      this,
      finishData,
      {
        revisedTaskInfo: revisedTaskInfo,
        wrappedTasks: wrappedTasks
      })
    .then(() => {
      if (wrappedTasks) {
        // (Even though we currently know the task id prior to this transaction
        // running, the idea is that IndexedDB should really be assigning the
        // id's as part of the transaction, so we will only have assigned id's
        // at this point.  See the __wrapTasks documentation for more context.)
        this.universe.taskManager.__enqueuePersistedTasksForPlanning(
          wrappedTasks);
      }
    });
  },
};
return TaskContext;
});

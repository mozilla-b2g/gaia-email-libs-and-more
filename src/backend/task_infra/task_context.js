import logic from 'logic';

/**
 * Provides helpers and standard arguments/context for tasks.
 */
export default function TaskContext(taskThing, universe) {
  this.id = taskThing.id;
  this._taskThing = taskThing;
  // The TaskRegistry will clobber this onto us so we can know the `this` to
  // provide to any subtasks.
  this.__taskInstance = null;

  // It's a TaskMarker if the type is on the root.  We care just because it
  // determines where the task metadata is.  This does not have any other
  // significance.
  //
  // Specifically, simple task types and complex task types both receive
  // non-markers as input to their planning phase.
  this.isMarker = !!taskThing.type;
  // If it's a marker, we're executing, otherwise it depends on the state.
  this.isPlanning = this.isMarker ? false : (taskThing.state === null);
  this.universe = universe;

  // We define the scope after the init above because we want to be able to
  // use our getters that tell us what is up.  However, this should always
  // precede any method calls.
  logic.defineScope(
    // We are used as the scope for all logging by the task, so call ourselves
    // "Task" instead of TaskContext.  We leave it to the logger UI to be
    // configured to extract the `taskType` and show that with more
    // significance.  This is somewhat arbitrary and roundabout, but it seems
    // desirable to have our logging namespaces have a strong static correlation
    // to what is instantiating them.
    this, 'Task',
    {
      id: taskThing.id,
      taskType: this.taskType,
      accountId: this.accountId
    });

  this._stuffToRelease = [];
  this._preMutateStates = null;
  this._subtaskCounter = 0;

  this._decoratorCallbacks = [];

  /**
   * @type {'prep'|'mutate'|'finishing'}
   */
   this.state = 'prep';
}
TaskContext.prototype = {
  get taskMode() {
    if (this.isPlannning) {
      return 'planning';
    } else {
      return 'executing';
    }
  },

  /**
   * Return the type of the task.
   */
  get taskType() {
    if (this.isMarker) {
      return this._taskThing.type;
    }
    if (this.isPlanning) {
      return this._taskThing.rawTask.type;
    } else {
      return this._taskThing.plannedTask.type;
    }
  },

  /**
   * Return the account id this task is associated with.  It's possible for this
   * to be null for global tasks.
   */
  get accountId() {
    if (this.isMarker) {
      return this._taskThing.accountId || null;
    }
    if (this.isPlanning) {
      return this._taskThing.rawTask.accountId || null;
    } else {
      return this._taskThing.plannedTask.accountId || null;
    }
  },

  /**
   * Returns whether we think the device is currently online.
   */
  get deviceOnline() {
    return this.universe.online;
  },

  /**
   * Returns whether we think the account associated with this task is currently
   * experiencing problems.
   *
   * TODO: Actually make this do something or remove it.  This was speculatively
   * introduced in keeping with the pre-convoy implementation, but we've now
   * begun to use resources to track more of this.
   */
  get accountProblem() {
    return false;
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
  get _taskGroupTracker() {
    return this.universe.taskGroupTracker;
  },

  /**
   * Asynchronously acquire a resource and track that we are using it so that
   * when the task completes or is terminated we can automatically release all
   * acquired resources.
   */
  acquire(acquireable) {
    this._stuffToRelease.push(acquireable);
    return acquireable.__acquire(this);
  },

  acquireAccountsTOC() {
    return this.universe.acquireAccountsTOC(this);
  },

  _releaseEverything() {
    for (let acquireable of this._stuffToRelease) {
      try {
        acquireable.__release(this);
      } catch (ex) {
        logic(
          this, 'problemReleasing',
          { what: acquireable, ex, stack: ex && ex.stack });
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
   * @param {String} consultWhat.name
   *   The task you want to talk to.
   * @param {AccountId} consultWhat.accountId
   *   The id of the account you want to talk to if the task isn't global.
   * @param {Object} argDict
   *   The argument object to be passed to the complex task.
   */
  synchronouslyConsultOtherTask(consultWhat, argDict) {
    return this._taskRegistry.__synchronouslyConsultOtherTask(
      this, consultWhat, argDict);
  },

  /**
   * Ensure that a task group with the given name exists and that this task
   * belongs to the group.  Returns a Promise that will be resolved when the
   * last task in the group completes.
   */
  trackMeInTaskGroup(groupName) {
    return this._taskGroupTracker.ensureNamedTaskGroup(groupName, this.id);
  },

  /**
   * The id of the root ancestral task group that contains this task.  You would
   * likely use this for high level "hey, is this the same batch of things as
   * the last batch of things" if you are a database trigger handler or
   * something like that.  Note that the id is different from the name of the
   * task group.  Task group names may be semantic things like
   * "sync_refresh:ACCOUNTID" which will be reused each time, whereas the group
   * id is by-design unique for each task group within a mailuniverse lifetime.
   *
   * You likely want the root task group instead of the most specific task group
   * because task groups are hierarchical and there is no rule about introducing
   * new levels of hierarchy to fix a problem.  So if you depended on the most
   * specific group, you could be subtly broken by implementation changes,
   * which would suck.  New containing roots are unlikely to occur without
   * serious semantic intent, and in that case you may want it anyways.
   *
   * If you think you know better, what you probably want is to be able to
   * provide a regexp that is run against the names of the task group ancestry
   * until a match is reached.
   */
  get rootTaskGroupId() {
    let rootTaskGroup = this._taskGroupTracker.getRootTaskGroupForTask(this.id);
    if (rootTaskGroup) {
      return rootTaskGroup.groupId;
    } else {
      return null;
    }
  },

  /**
   * Find the root task group and put this task in the set of tasks to schedule
   * when the group completes.  As an optimization, a Set is used to store the
   * tasks, so if you want to avoid needlessly duplicated tasks, it's preferable
   * if you can use a single object instance to schedule your tasks.  If you
   * can't make this happen and may generate a large number of potentially
   * redundant tasks without any other workaround, please consider adding
   * support for de-duplicating via explicit namespaced string.  (For large,
   * I'm thinking 10+ per task in a normal case.)
   */
  ensureRootTaskGroupFollowOnTask(taskToPlan) {
    this._taskGroupTracker.ensureRootTaskGroupFollowOnTask(this.id, taskToPlan);
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
  setFailureTasks(/*tasks*/) {
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
  heartbeat(/* why */) {
    this._taskManager.__renewWakeLock();
  },

  broadcastOverBridges(name, data) {
    return this.universe.broadcastOverBridges(name, data);
  },

  /**
   * Notify interested parties that our overlay contribution to the given id in
   * the given namespace has (probably) changed.  Note that we don't provide
   * the data; it gets pulled from us on-demand.
   *
   * Also note that you don't need to go crazy announcing updates.  For example,
   * if you're maintaining a download progress in bytes and are updating the
   * byte count every time you get a packet, you don't actually need to announce
   * every change.
   */
  announceUpdatedOverlayData(namespace, id) {
    this.universe.dataOverlayManager.announceUpdatedOverlayData(namespace, id);
  },

  /**
   * Read one or more pieces of data from the database.  This does not acquire
   * a write-lock.  You absolutely must *not* mutate the objects returned.  If
   * you later on want to mutate the record, you should use `beginMutate` and at
   * that point update your variable to use the object returned (which may
   * differ!).  See `MailDB.read` for more extensive signature details.
   */
  read(what) {
    return this.universe.db.read(this, what);
  },

  /**
   * Helper to read a single piece of data which you're not planning on
   * mutating.  If you're thinking of using this multiple times in succession
   * without a data-dependency between them, then you want to be using `read`.
   * If you're think of trying to mutate what's returned, you want one of:
   * `mutateSingle`, `beginMutate` or `spawnSimpleMutationSubtask`.
   *
   * @param {String} namespace
   *   The key you'd use in a `read` request.  Like `messages` or `conversations`
   * @param {String|Array} reqId
   *   The id to use in the read request.  In the case of `messages`, this would
   *   be a list of the form [MessageId, DateMS] and you would also provide
   *   `readbackId`.  Most of the time, the id is just the id and you don't
   *   need to provide a `readbackId`.
   * @param {String} [readbackId]
   *   Required in cases where the read id is not the same as the id that the
   *   result will have, like for `messages`.
   * @return {Promise}
   *   A promise that will be resolved with the read result (which could be
   *   null!), or will throw if the underlying read request fails and throws.
   */
  readSingle(namespace, reqId, readbackId) {
    let readMap = new Map();
    readMap.set(reqId, null);
    let req = {
      [namespace]: readMap
    };

    return this.universe.db.read(this, req).then((results) => {
      return results[namespace].get(readbackId || reqId);
    });
  },

  /**
   * Helper to read a single piece of data while also acquiring a write-lock.
   * See/understead `readSingle` and `beginMutate` before trying to use this.
   */
  mutateSingle(namespace, reqId, readbackId) {
    let readMap = new Map();
    readMap.set(reqId, null);
    let req = {
      [namespace]: readMap
    };

    return this.universe.db.beginMutate(this, req).then((results) => {
      return results[namespace].get(readbackId || reqId);
    });
  },

  /**
   * Basically `read` but you're also acquiring write-locks on the records you
   * request for access.  If some other task is currently holding the
   * write-locks, then your task will block until the other task releases them.
   * If you previously issued a `read` for any of these values, make sure that
   * you update your variable to what we return here, because object identity
   * may not hold.  See `MailDB.beginMutate` for more details.
   *
   * You should only acquire write-locks when your task is done waiting on
   * network traffic and will complete in a timely fashion.  It is okay to be
   * I/O bound; just don't be depending on things that could take an arbitrary
   * amount of time.
   *
   * If you want to write some data to disk but your task wants to keep running,
   * then you can spawn a subtask which can do beginMutate and complete in a
   * timely fashion.  See `spawnSubtask` and `spawnSimpleMutationSubtask`.
   */
  beginMutate(what) {
    if (this.state !== 'prep') {
      throw new Error(
        'Cannot switch to mutate state from state: ' + this.state);
    }
    this.state = 'mutate';
    return this.universe.db.beginMutate(this, what);
  },

  /**
   * Immediately spawn a helper sub-task, returning a Promise that will be
   * resolved when the subtask completes.  The caller/owning task is responsible
   * for waiting on all of its sub-tasks to resolve or reject before completing.
   *
   * The subtask will be invoked with its own `TaskContext` as its first
   * argument and the provided argument object as its second object.  The `this`
   * for the task will be the `this` currently associated with the task.
   *
   * Subtasks are intended to be used for cases where write locks need to be
   * taken and then the write promptly performed, inherently releasing the
   * write-lock.
   *
   * @param {Function(TaskContext, argObj)} subtaskFunc
   *   The subtask function that takes a TaskContext and the argument object
   *   provided to `spawnSubtask` and returns a Promise.  tthe `this` for the
   *   invocation will be the `this` of your task instance, so you can safely do
   *   `this.someOtherHelperOnMyTask` without having to use bind() yourself or
   *   use an arrow function.
   * @param {Object} [argObj]
   *   An optional argument object to pass as the second argument to your
   *   async func.  This is the second argument because it's assumed that if
   *   you are declaring your subtask inline that you will just close over/
   *   capture the arguments you want and won't specify the argument object.
   *   In the case your subtask is a separate helper function, you probably
   *   would want to provide the object.
   * @return {Promise}
   */
  spawnSubtask(subtaskFunc, argObj) {
    let subId = 'sub:' + this.id + ':' + this._subtaskCounter++;
    let subThing = {
      id: subId,
      type: 'subtask'
    };
    let subContext = new TaskContext(subThing, this.universe);
    return this._taskManager.__trackAndWrapSubtask(
      this, subContext, subtaskFunc, argObj);
  },

  /**
   * Helper for subtasks where you basically just want to apply some changes to
   * a record from disk.  You name the namespace and id like in `mutateSingle`,
   * we create a subtask that issues that call, calls your *synchronous*
   * function with the result, and then writes whatever you return back.  (It
   * can be the same object if you want, a new object if you want, or null if
   * you want to delete the object.)  If you want an asynchronous function,
   * then you need to use `spawnSubtask` directly.
   *
   * We currently do not do anything with flushed reads because our driving
   * consumer (mix_download) does not need the functionality.  (Specifically,
   * its `persistentState` introduces complexities since it may only be mutated
   * while holding the write lock, so a flushed read is not useful since we need
   * to re-acquire a write-lock.  Luckily mix_download does some expensive stuff
   * with that.
   */
  spawnSimpleMutationSubtask({ namespace, id }, mutateFunc ) {
    return this.spawnSubtask(
      this._simpleMutationSubtask, { mutateFunc, namespace, id });
  },

  async _simpleMutationSubtask(subctx, { mutateFunc, namespace, id }) {
    // note! our 'this' context is that of the task implementation!
    let obj = await subctx.mutateSingle(namespace, id);

    let writeObj = mutateFunc.call(this, obj);

    await subctx.finishTask({
      mutations: {
        [namespace]: new Map([[id, writeObj]])
      }
    });

    // NB: this is where we'd do a flushed read-back if we wanted to.
    return writeObj;
  },

  /**
   * Perform a write of an object, retaining the write-lock, followed by
   * immediately reading the object back.  This only makes sense for Blob
   * laundering where we try and forget about memory-backed Blobs in favor of
   * disked-back Blobs (or more properly after read-back, Files).
   *
   * XXX I wrote this comment but didn't end up using it, but it's a good
   * comment so here it sits with the open question: would this be a good idea?
   * TODO: Review the attachment tasks and see if time has made this seem like
   * a better approach than what we ended up using for blob laundering.
   */
  flushedWriteRetainingLock() {
    throw new Error(); // make a stupid call, get a stupid error.
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
   * - draft attaching.  This is an offline I/O bound process, so the hack here
   *   is more about forgetting about memory-backed Blobs in favor of
   *   disk-backed Blobs.
   */
  mutateMore(what) {
    if (this.state !== 'mutate') {
      throw new Error(
        'You should already be mutating, not in state: ' + this.state);
    }
    return this.universe.db.beginMutate(this, what);
  },

  /**
   * Quite possibly moot, don't use without discussion with asuth.  If asuth,
   * mumble to self madly.
   */
  dangerousIncrementalWrite(mutations) {
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
   * @param {Object} [finishData.atomicClobbers]
   * @param {Object} [finishData.atomicDeltas]
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
  finishTask(finishData) {
    if (this.state === 'finishing') {
      throw new Error('already finishing! did you put finishTask in a loop?');
    }
    this.state = 'finishing';

    const taskManager = this.universe.taskManager;
    let revisedTaskInfo;
    // If this isn't a marker, then there is a task state that needs to either
    // be revised or nuked.
    if (!this.isMarker) {
      if (finishData.taskState) {
        // (Either this was the planning stage or an execution stage that didn't
        // actually complete; we're still planned either way.)
        this._taskThing.state = 'planned';
        this._taskThing.plannedTask = finishData.taskState;
        revisedTaskInfo = {
          id: this.id,
          value: this._taskThing
        };
        taskManager.__queueTasksOrMarkers(
          [this._taskThing], this.id, true);
      } else {
        revisedTaskInfo = {
          id: this.id,
          value: null
        };
      }
      // If this task is nonpersistent, then clobber revisedTaskInfo to be
      // null so that we don't try to delete any task record (it never got
      // written to the database!) and so that we don't create a new one.
      // (We do this here after the above because we do want the  first case to
      // apply, so stealing control flow to avoid both cases is not desirable.)
      if (this._taskThing.nonpersistent) {
        revisedTaskInfo = null;
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
          taskManager.__queueTasksOrMarkers(
            [taskMarker], this.id, true);
        }
        // nuke the marker
        else {
          taskManager.__removeTaskOrMarker(markerId, this.id);
        }
      }
    }

    // Normalize any tasks that should be byproducts of this task.
    let wrappedTasks = null;
    if (finishData.newData && finishData.newData.tasks) {
      wrappedTasks =
        taskManager.__wrapTasks(finishData.newData.tasks);
    }

    if (finishData.undoTasks) {
      taskManager.emit(`undoTasks:${this.id}`, finishData.undoTasks);
    }

    // If __failsafeFinalize was invoked (and we hadn't already finished), the
    // callbacks will already have been notified of failure and cleared.
    for (const decoratorCallback of this._decoratorCallbacks) {
      decoratorCallback(this, true, finishData);
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
        taskManager.__enqueuePersistedTasksForPlanning(wrappedTasks, this.id);
      }
    });
  },

  /**
   * We need to wrap return values that are Promises because otherwise automatic
   * promise chaining gets us.  So we create an explicit wrapper to conceal the
   * hacky convention.  Also, when we come up with a better way to handle this,
   * this might be easier to search and replace.
   */
  returnValue(value) {
    return { wrappedResult: value };
  },

  __failsafeFinalize() {
    // things are good if we finished automatically.
    if (this.state === 'finishing') {
      return;
    }

    logic(this, 'failsafeFinalize');

    // notify decorator callbacks of failure
    for (const decoratorCallback of this._decoratorCallbacks) {
      try {
        decoratorCallback(this, false, null);
      } catch (ex) {
        logic(this, 'decoratorFailsafeFail', { ex });
      }
    }
    this._decoratorCallbacks = [];

    // empty object implies empty taskState.
    this.finishTask({});
  },

  /**
   * A helper for `FoldersTOC.ensureLocalVirtualFolder` and similar use-cases
   * where an in-memory source of truth needs to manage speculative shared state
   * that should be transactionally committed to disk when the relevant tasks
   * complete.
   */
  __decorateFinish(callback) {
    this._decoratorCallbacks.push(callback);
  }
};

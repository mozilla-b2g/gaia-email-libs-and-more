define(function(require) {
'use strict';

const co = require('co');
const evt = require('evt');
const logic = require('logic');

const TaskContext = require('./task_context');

const { SmartWakeLock } = require('./wakelocks');

/**
 * The public API and ultimate coordinator of all tasks.  Tracks and prioritizes
 * the pending tasks to be executed.  Also handles some glue logic and is likely
 * to be the home of ugly hacks related to tasks.  Compare with:
 * - `TaskDefiner`: Exposes helpers/mix-ins for the implementation of tasks.
 * - `TaskRegistry`: Tracks the known global and per-account tasks and drives
 *   the actual execution of the tasks once TaskManager has decided what should
 *   get executed.  `TaskManager` and its creator, `MailUniverse` handle some
 *   glue logic.
 * - `TaskResources`: In charge of tracking available resources, knowing when a
 *   planned task/markers hould be blocked by an unavailable resource, and
 *   timer-related issues.  Non-trivially coupld to us.
 * - `TaskContext`: Provides the execution context and helpers for tasks as they
 *   are run.
 *
 * Tasks will not be processed until the `MailUniverse` invokes our
 * `__restoreFromDB` method and we have fully initialized all complex tasks.
 * (Complex task initialization can be async.)
 */
function TaskManager({ universe, db, registry, resources, priorities,
                       accountsTOC }) {
  evt.Emitter.call(this);
  logic.defineScope(this, 'TaskManager');
  this._universe = universe;
  this._db = db;
  this._registry = registry;
  this._resources = resources;
  this._priorities = priorities;
  this._accountsTOC = accountsTOC;

  // XXX SADNESS.  So we wanted to use autoincrement to avoid collisions or us
  // having to manage a counter.  Unfortunately, we want to use mozGetAll for
  // retrieval, but that can't include the keys, so we need to always have
  // the key inside the value.  To avoid managing the counter we go with a
  // strategy to avoid colliding keys, probably.  We use Date.now and then
  // assume that we won't generate tasks at a sustainted rate of more than 100
  // tasks per millisecond (on average).
  let idBase = (Date.now() - 1400000000000);
  if (idBase < 0) {
    throw new Error('clock is bad, correctness compromised, giving up.');
  }
  this._nextId = idBase * 100;

  /**
   * @type{RawTask[]}
   * The tasks that we still need to plan (but have scheduled/durably persisted
   * to disk.)
   */
  this._tasksToPlan = [];


  // Wedge our processing infrastructure until we have loaded everything from
  // the database.  Note that nothing will actually .then() off of this, and
  // we're just using an already-resolved Promise for typing reasons.
  this._activePromise = Promise.resolve(null);

  /**
   * The SmartWakeLock we're holding, if any.  We hold the wakelocks rather than
   * our tasks doing it themselves because we manage their lifecycles anyways
   * and it's not like the wakelocks are for "highspeed" or anything fancy.  We
   * need to hold the "cpu" wakelock if we want our code to keep executing, and
   * we need to hold the "wifi" wakelock if we want to keep our network around.
   * (There is some ugliness related to the "wifi" wakelock that we won't get
   * into here.)  In the event wakelocks get fancier, we'll potentially deal
   * with that by exposing additional data on the task or adding helpers to the
   * TaskContext.
   *
   * Current we:
   * - Acquire the wakelock when we have any work to do.
   * - Renew the wakelock at the point we would have acquired it if we didn't
   *   already hold it.  The SmartWakeLock defaults to a 45 second timeout
   *   which we're currently calling more than sufficiently generous, but
   *   long-running tasks are on the hook for invoking TaskContext.heartbeat()
   *   to help us renew the wakelock while it's still going.
   * - Release the wakelock when we run out of things to do.
   */
  this._activeWakeLock = null;
}
TaskManager.prototype = evt.mix({
  __restoreFromDB: co.wrap(function*() {
    let { wrappedTasks, complexTaskStates } = yield this._db.loadTasks();
    logic(this, 'restoreFromDB', { count: wrappedTasks.length });

    // -- Restore wrapped tasks
    for (let wrappedTask of wrappedTasks) {
      if (wrappedTask.state === null) {
        this._tasksToPlan.push(wrappedTask);
      } else {
        this.__queueTasksOrMarkers(wrappedTask, 'restored', true);
      }
    }

    // -- Push complex task state into complex tasks
    let pendingInitPromises = [];
    this._registry.initializeFromDatabaseState(complexTaskStates);
    this._accountsTOC.getAllItems().forEach((accountInfo) => {
      pendingInitPromises.push(
        this._registry.accountExistsInitTasks(
          accountInfo.id, accountInfo.engine)
        .then((markers) => {
          this.__queueTasksOrMarkers(markers, 'restored', true);
        }));
    });
    this._accountsTOC.on('add', (accountInfo) => {
      this._registry.accountExistsInitTasks(accountInfo.id, accountInfo.engine)
        .then((markers) => {
          this.__queueTasksOrMarkers(markers, 'restored', true);
        });
    });
    this._accountsTOC.on('remove', (accountInfo) => {
      this._registry.accountRemoved(accountInfo.id);
      // TODO: we need to reap the markers
    });

    // -- Trigger processing when all initialization has completed.
    Promise.all(pendingInitPromises).then(() => {
      this._activePromise = null;
      this._maybeDoStuff();
    });
  }),

  /**
   * Ensure that we have a wake-lock.  Invoke us when something happens that
   * means the TaskManager has or will soon have work to do and so we need to
   * stay awake.
   */
  _ensureWakeLock: function() {
    if (!this._activeWakeLock) {
      this._activeWakeLock = new SmartWakeLock({ locks: ['cpu'] });
    } else {
      this._activeWakeLock.renew('TaskManager:ensure');
    }
  },

  __renewWakeLock: function() {
    if (this._activeWakeLock) {
      this._activeWakeLock.renew('TaskManager:explicit');
    } else {
      logic.fail('explicit renew propagated without a wakelock?');
    }
  },

  /**
   * Release the wakelock *because we are sure we have no more work to do right
   * now*.  We don't do reference counted nesting or anything like that.  We've
   * got work to do or we don't.
   */
  _releaseWakeLock: function() {
    if (this._activeWakeLock) {
      this._activeWakeLock.unlock('TaskManager:release');
      this._activeWakeLock = null;
    }
  },

  /**
   * Schedule one or more persistent tasks.
   *
   * Resolved with the ids of the task once they have been durably persisted to
   * disk.  You should not care about the id unless you are a unit test.  For
   * all user-visible things, you should be listening on a list view or a
   * specific object identifier, etc.  (Ex: if you care about an attachment
   * being downloaded, listen to the message itself or view the list of pending
   * downloads.)
   *
   * This method should only be called by things that are not part of the task
   * system, like user-triggered actions.  Tasks should list the tasks they
   * define during their call to finishTask.
   *
   * @param {RawTask[]} rawTasks
   * @param {String} why
   *   Human readable but terse label to explain the causality/rationale of this
   *   task being scheduled.
   * @return {Promise<TaskId[]>}
   *   A promise that's resolved with an array populated with the
   *   resulting task ids of the tasks.  This is a tenative babystep
   *   towards v3 undo support.  This may be removed.
   */
  scheduleTasks: function(rawTasks, why) {
    this._ensureWakeLock();
    let wrappedTasks = this.__wrapTasks(rawTasks);

    logic(this, 'schedulePersistent', { why: why, tasks: wrappedTasks });

    return this._db.addTasks(wrappedTasks).then(() => {
      this.__enqueuePersistedTasksForPlanning(wrappedTasks);
      return wrappedTasks.map(x => x.id);
    });
  },

  /**
   * Return a promise that will be resolved when the tasks with the given id's
   * have been planned.  The resolved value is a list of the declared results
   * of each task having been planned.  Tasks may optionally return a result;
   * if they return no result, `undefined` will be returned.
   *
   * Note that there is no corresponding method for the execute stage because
   * timely execution of `execute` tasks is no guaranteed and so it's deemed
   * a foot-gun.  The results of task execution should be propagated through
   * manipulations to database records or via the overlay mechanism.
   */
  waitForTasksToBePlanned: function(taskIds) {
    return Promise.all(taskIds.map((taskId) => {
      return new Promise((resolve) => {
        this.once('planned:' + taskId, resolve);
      });
    }));
  },

  /**
   * Schedule one or more non-persistent tasks.  You only want to do this for
   * tasks whose arguments are things that should not be persisted to disk and
   * for which it's expected that the task will run quickly.  The canonical
   * example is attaching files to a draft where we (currently) encode in
   * bite-size chunks.  (Noting that we want to change this.)
   *
   * In general you don't want to be calling this.
   */
  scheduleNonPersistentTasks: function(rawTasks, why) {
    this._ensureWakeLock();
    let wrappedTasks = this.__wrapTasks(rawTasks);
    logic(this, 'scheduleNonPersistent', { why: why, tasks: wrappedTasks });

    wrappedTasks.forEach((wrapped) => {
      wrapped.nonpersistent = true;
    });
    this.__enqueuePersistedTasksForPlanning(wrappedTasks);
    return Promise.resolve(wrappedTasks.map(x => x.id));
  },


  /**
   * Wrap raw tasks and issue them an id, suitable for persisting to the
   * database.
   */
  __wrapTasks: function(rawTasks) {
    return rawTasks.map((rawTask) => {
      return {
        id: this._nextId++,
        rawTask: rawTask,
        state: null // => planned => (deleted)
      };
    });
  },

  /**
   * Enqueue the given tasks for planning now that they have been persisted to
   * disk.
   */
  __enqueuePersistedTasksForPlanning: function(wrappedTasks) {
    this._ensureWakeLock();
    this._tasksToPlan.splice(this._tasksToPlan.length, 0, ...wrappedTasks);
    this._maybeDoStuff();
  },

  /**
   * Makes us aware of planend tasks or complex task markers.  This happens
   * as tasks / complex states are restored from the database, or planning
   * steps complete (via `TaskContext`).
   *
   * We call TaskResources and it decides whether to keep it or pass it on to
   * TaskPriorities.
   */
  __queueTasksOrMarkers: function(taskThings, sourceId, noTrigger) {
    let prioritized = 0;
    for (let taskThing of taskThings) {
      logic(this, 'queueing', { taskThing: taskThing, sourceId });
      if (this._resources.ownOrRelayTaskThing(taskThing)) {
        prioritized++;
      }
    }
    // If nothing is happening, then we might need/want to call _maybeDoStuff
    // soon, but not until whatever's calling us has had a chance to finish.
    // And if something is happening, well, we already know we will call
    // _maybeDoStuff when that happens.  (Note that we must not call
    // _maybeDoStuff synchronously because _maybeDoStuff may already be on the
    // stack, waiting for a promise to be returned to it.)
    // XXX Audit this more and potentially ensure there's only one of these
    // nextTick-style hacks.  But right now this should be harmless but
    // wasteful.
    if (prioritized && !noTrigger && !this._activePromise) {
      Promise.resolve().then(() => {
        this._maybeDoStuff();
      });
    }
  },

  /**
   * Allows TaskContext to trigger removal of complex task markers when
   * requested by complex tasks.
   */
  __removeTaskOrMarker: function(taskId) {
    logic(this, 'removing', { taskId });
    this._resources.removeTaskThing(taskId);
  },

  /**
   * If we have any task planning or task executing to do.
   *
   * XXX as a baby-steps simplification, right now we only do one of these at a
   * time.  We *absolutely* do not want to be doing this forever.
   */
  _maybeDoStuff: function() {
    if (this._activePromise) {
      return;
    }

    if (this._tasksToPlan.length) {
      this._activePromise = this._planNextTask();
    } else if (!this._priorities.hasTasksToExecute()) {
      this._activePromise = this._executeNextTask();
    } else {
      logic(this, 'nothingToDo');
      this._releaseWakeLock();
      // bail, intentionally doing nothing.
      return;
    }

    if (!this._activePromise) {
      // If we're here it means that we tried to to plan/execute a task but
      // either they completed synchronously (with success) or had to fast-path
      // out because of something bad happening.  Either way, we want to
      // potentially invoke this function again since we're not chaining onto
      // a promise.
      //
      // TODO: consider whether a while loop would be a better approach over
      // this.  Right now we're effectively being really paranoid to make sure
      // we clear the stack.
      if (this._tasksToPlan.length || !this._priorities.hasTasksToExecute()) {
        setTimeout(() => { this._maybeDoStuff(); }, 0);
      }
      return;
    }

    this._activePromise.then(() => {
      this._activePromise = null;
      this._maybeDoStuff();
    }, (err) => {
      this._activePromise = null;
      logic(this, 'taskError', { err: err, stack: err.stack });
      this._maybeDoStuff();
    });
  },

  /**
   * Plan the next task.  This task will advance to 'planned' atomically as part
   * of the completion of planning.  In the case of simple tasks, this will
   * happen via a call to `__queueTasksOrMarkers` via TaskContext.
   */
  _planNextTask: function() {
    let wrappedTask = this._tasksToPlan.shift();
    logic(this, 'planning:begin', { task: wrappedTask });
    let ctx = new TaskContext(wrappedTask, this._universe);
    let planResult = this._registry.planTask(ctx, wrappedTask);
    if (planResult) {
      planResult.then((returnedResult) => {
        logic(this, 'planning:end', { task: wrappedTask });
        this.emit('planned:' + wrappedTask.id, returnedResult);
      });
    } else {
      logic(this, 'planning:end', { moot: true, task: wrappedTask });
      this.emit('planned:' + wrappedTask.id, undefined);
    }
    return planResult;
  },

  _executeNextTask: function() {
    let taskThing = this._priorities.popNextAvailableTask();
    let isTask = !taskThing.type;
    logic(this, 'executing:begin', { task: taskThing });

    let ctx = new TaskContext(taskThing, this._universe);
    let execResult = this._registry.executeTask(ctx, taskThing);
    if (execResult) {
      execResult.then(() => {
        logic(this, 'executing:end', { task: taskThing });
        this.emit('executed:' + taskThing.id);
      });
    } else {
      logic(this, 'executing:end', { moot: true, task: taskThing });
      this.emit('executed:' + taskThing.id);
    }
    return execResult;
  }
});

return TaskManager;
});

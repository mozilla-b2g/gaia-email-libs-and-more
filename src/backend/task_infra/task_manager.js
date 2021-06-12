import evt from 'evt';
import logic from 'logic';

import TaskContext from './task_context';

import { SmartWakeLock } from '../wakelocks';

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
export default function TaskManager({ universe, db, taskRegistry, taskResources,
                                      taskPriorities, accountManager }) {
  evt.Emitter.call(this);
  logic.defineScope(this, 'TaskManager');
  this._universe = universe;
  this._db = db;
  this._registry = taskRegistry;
  this._resources = taskResources;
  this._priorities = taskPriorities;
  this._accountManager = accountManager;
  this._accountsTOC = accountManager.accountsTOC;

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
  /**
   * Track the number of plan writes so that we can avoid declaring the queue
   * empty if there will soon be enqueued tasks once the write completes.
   */
  this._pendingPlanWrites = 0;

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
  async __restoreFromDB() {
    let { wrappedTasks, complexTaskStates } =
      await this._db.loadTasks();
    logic(this, 'restoreFromDB', { count: wrappedTasks.length });

    // -- Restore wrapped tasks
    for (let wrappedTask of wrappedTasks) {
      if (wrappedTask.state === null) {
        this._tasksToPlan.push(wrappedTask);
      } else {
        this.__queueTasksOrMarkers([wrappedTask], 'restored:simple', true);
      }
    }

    // -- Push complex task state into complex tasks
    let pendingInitPromises = [];
    this._registry.initializeFromDatabaseState(complexTaskStates);
    // Initialize the global tasks.
    pendingInitPromises.push(
      this._registry.initGlobalTasks()
      .then((markers) => {
        this.__queueTasksOrMarkers(markers, 'restored:complex', true);
      }));

    this._accountsTOC.getAllItems().forEach((accountInfo) => {
      let foldersTOC =
        this._accountManager.accountFoldersTOCs.get(accountInfo.id);
      pendingInitPromises.push(
        this._registry.accountExistsInitTasks(
          accountInfo.id, accountInfo.engine, accountInfo, foldersTOC)
        .then((markers) => {
          this.__queueTasksOrMarkers(markers, 'restored:complex', true);
        }));
    });
    this._accountsTOC.on('add', (accountInfo) => {
      let foldersTOC =
        this._accountManager.accountFoldersTOCs.get(accountInfo.id);
      this._registry.accountExistsInitTasks(
        accountInfo.id, accountInfo.engine, accountInfo, foldersTOC)
      .then((markers) => {
        this.__queueTasksOrMarkers(markers, 'restored:complex', true);
      });
    });
    this._accountsTOC.on('remove', (accountInfo) => {
      this._registry.accountRemoved(accountInfo.id);
      // TODO: we need to reap the markers
    });

    // -- Trigger processing when all initialization has completed.
    Promise.all(pendingInitPromises).then(() => {
      this._activePromise = null;
      logic(
        this, 'starting',
        {
          numTasksToPlan: this._tasksToPlan.length,
          numPrioritizedTasks: this._priorities.numTasksToExecute
        });
      this._maybeDoStuff();
    });
  },

  /**
   * Ensure that we have a wake-lock.  Invoke us when something happens that
   * means the TaskManager has or will soon have work to do and so we need to
   * stay awake.
   */
  _ensureWakeLock(why) {
    if (!this._activeWakeLock) {
      logic(this, 'ensureWakeLock', { why });
      this._activeWakeLock = new SmartWakeLock({ locks: ['cpu'] });
    } else {
      this._activeWakeLock.renew('TaskManager:ensure');
    }
  },

  __renewWakeLock() {
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
  _releaseWakeLock() {
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
  scheduleTasks(rawTasks, why) {
    this._ensureWakeLock(why);
    let wrappedTasks = this.__wrapTasks(rawTasks);

    logic(this, 'schedulePersistent', { why: why, tasks: wrappedTasks });

    this._pendingPlanWrites++;
    return this._db.addTasks(wrappedTasks).then(() => {
      this._pendingPlanWrites--;
      this.__enqueuePersistedTasksForPlanning(wrappedTasks);
      return wrappedTasks.map(x => x.id);
    });
  },

  /**
   * Return a promise that will be resolved when the tasks with the given id's
   * have been planned.  The resolved value is a list of the declared results
   * of each task having been planned.  Tasks may optionally return a result;
   * if they return no result, `undefined` will be returned.
   */
  waitForTasksToBePlanned(taskIds) {
    return Promise.all(taskIds.map((taskId) => {
      return new Promise((resolve) => {
        this.once('planned:' + taskId, resolve);
      });
    }));
  },

  /**
   * Schedule a persistent task, returning a promise that will be resolved
   * with the return value of the task's planning stage.
   */
  scheduleTaskAndWaitForPlannedResult(rawTask, why) {
    return this.scheduleTasks([rawTask], why)
    .then((taskIds) => {
      return this.waitForTasksToBePlanned(taskIds);
    }).then((results) => {
      return results[0];
    });
  },

  /**
   * Schedule a task and wait for it to be planned and possibly generate undo
   * tasks.  We return a Promise that will be resolved with the list of undo
   * tasks generated.  Note that failure to generate a specific list of undo
   * tasks is treated as if an empty list had been generated.
   */
  scheduleTaskAndWaitForPlannedUndoTasks(rawTask, why) {
    return this.scheduleTasks([rawTask], why)
    .then(([taskId]) => {
      return new Promise((resolve) => {
        // We can't guarantee that the undo event will be generated, so we need
        // to infer no undo tasks were generated if we saw planned.  Also,
        // since we can only use removeListener on once()-bound listeners if
        // there was an associated object, we add the undo listener just using
        // `on` and explicitly remove it in our (guaranteed-to-fire) `once`
        // planned handler.
        let undoHandler = (undoTasks) => {
          resolve(undoTasks);
        };
        let ensureCleanup = () => {
          this.removeListener(`undoTasks:${taskId}`, undoHandler);
          // (will be ignored if the undo handler fired.)
          resolve([]);
        };
        this.on(`undoTasks:${taskId}`, undoHandler);
        this.once(`planned:${taskId}`, ensureCleanup);
      });
    });
  },

  /**
   * Schedule a persistent task, returning a promise that will be resolved
   * with the return value of the task's execution stage.
   */
  scheduleTaskAndWaitForExecutedResult(rawTask, why) {
    return this.scheduleTasks([rawTask], why)
    .then((taskIds) => {
      return this.waitForTasksToBeExecuted(taskIds);
    }).then((results) => {
      return results[0];
    });
  },

  /**
   * Return a promise that will be resolved when the tasks with the given id's
   * have been executed.  The resolved value is a list of the declared results
   * of each task having been executed.  Tasks may optionally return a result;
   * if they return no result, `undefined` will be returned.
   */
  waitForTasksToBeExecuted(taskIds) {
    return Promise.all(taskIds.map((taskId) => {
      return new Promise((resolve) => {
        this.once('executed:' + taskId, resolve);
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
  scheduleNonPersistentTasks(rawTasks, why) {
    this._ensureWakeLock(why);
    let wrappedTasks = this.__wrapTasks(rawTasks);
    logic(this, 'scheduleNonPersistent', { why: why, tasks: wrappedTasks });

    wrappedTasks.forEach((wrapped) => {
      wrapped.nonpersistent = true;
    });
    this.__enqueuePersistedTasksForPlanning(wrappedTasks);
    return Promise.resolve(wrappedTasks.map(x => x.id));
  },

  /**
   * Schedules a non-persistent task, returning a promise that will be resolved
   * with the return value of the task's planning stage.  Used for things like
   * creating a draft where a new name for something is created.  If you're
   * manipulating something that already has a name and for which you could
   * receive the events on that thing or its parent, then you ideally shouldn't
   * be using this.  (AKA start feeling guilty now.)
   *
   * Note that there is currently only a non-persistent version of this helper
   * because the expected idiom is that all actions are fundamentally
   * interactive.
   */
  scheduleNonPersistentTaskAndWaitForPlannedResult(rawTask, why) {
    return this.scheduleNonPersistentTasks([rawTask], why)
    .then((taskIds) => {
      return this.waitForTasksToBePlanned(taskIds);
    }).then((results) => {
      return results[0];
    });
  },

  /**
   * Schedules a non-persistent task, returning a promise that will be resolved
   * with the return value of the task's execution stage.  Used for things like
   * creating a new account where a new name for something is created.  If
   * you're manipulating something that already has a name and for which you
   * could receive the events on that thing or its parent, then you ideally
   * shouldn't be using this.  (AKA start feeling guilty now.)
   *
   * Note that there is currently only a non-persistent version of this helper
   * because the expected idiom is that all actions are fundamentally
   * interactive.
   */
  scheduleNonPersistentTaskAndWaitForExecutedResult(rawTask, why) {
    return this.scheduleNonPersistentTasks([rawTask], why)
    .then((taskIds) => {
      return this.waitForTasksToBeExecuted(taskIds);
    }).then((results) => {
      return results[0];
    });
  },


  /**
   * Wrap raw tasks and issue them an id, suitable for persisting to the
   * database.
   */
  __wrapTasks(rawTasks) {
    return rawTasks.map((rawTask) => {
      return {
        id: this._nextId++,
        rawTask,
        state: null // => planned => (deleted)
      };
    });
  },

  /**
   * Enqueue the given tasks for planning now that they have been persisted to
   * disk.
   */
  __enqueuePersistedTasksForPlanning(wrappedTasks, sourceId) {
    this._ensureWakeLock();
    for (let wrappedTask of wrappedTasks) {
      this.emit('willPlan', wrappedTask, sourceId);
    }
    this._tasksToPlan.splice(this._tasksToPlan.length, 0, ...wrappedTasks);
    this._maybeDoStuff();
  },

  /**
   * Makes us aware of planned tasks or complex task markers.  This happens
   * as tasks / complex states are restored from the database, or planning
   * steps complete (via `TaskContext`).
   *
   * We call TaskResources and it decides whether to keep it or pass it on to
   * TaskPriorities.
   */
  __queueTasksOrMarkers(taskThings, sourceId, noTrigger) {
    // Track the number of things task resources passed through to
    // TaskPriorities.  If this stays zero, everything was blocked on a resource
    // and there's no new work to do.
    let prioritized = 0;
    for (let taskThing of taskThings) {
      logic(this, 'queueing', { taskThing, sourceId });
      this.emit('willExecute', taskThing, sourceId);
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
  __removeTaskOrMarker(taskId) {
    logic(this, 'removing', { taskId });
    this._resources.removeTaskThing(taskId);
  },

  /**
   * If we have any task planning or task executing to do.
   *
   * XXX as a baby-steps simplification, right now we only do one of these at a
   * time.  We *absolutely* do not want to be doing this forever.
   */
  _maybeDoStuff() {
    if (this._activePromise) {
      return;
    }

    if (this._tasksToPlan.length) {
      this._activePromise = this._planNextTask();
    } else if (!this._priorities.hasTasksToExecute()) {
      this._activePromise = this._executeNextTask();
    } else {
      logic(this, 'nothingToDo');
      // Indicate the queue is empty if we're here and there aren't tasks that
      // will imminently be placed in the plan queue.  This primarily matters
      // for task groups with tasks to schedule when the group completes.  In
      // that case the call to scheduleTasks will occur before this code is
      // reached, but the writes will almost certainly not complete until after
      // this code has been reached.
      if (this._pendingPlanWrites === 0) {
        this.emit('taskQueueEmpty');
      }
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
    }, (error) => {
      this._activePromise = null;
      logic(this, 'taskError', { error, stack: error.stack });
      this._maybeDoStuff();
    });
  },

  /**
   * Plan the next task.  This task will advance to 'planned' atomically as part
   * of the completion of planning.  In the case of simple tasks, this will
   * happen via a call to `__queueTasksOrMarkers` via TaskContext.
   */
  _planNextTask() {
    let wrappedTask = this._tasksToPlan.shift();
    logic(this, 'planning:begin', { task: wrappedTask });
    let ctx = new TaskContext(wrappedTask, this._universe);
    let planResult = this._registry.planTask(ctx, wrappedTask);
    if (planResult) {
      planResult.then(
        (maybeResult) => {
          let result = maybeResult && maybeResult.wrappedResult || undefined;
          logic(this, 'planning:end', { success: true, task: wrappedTask });
          this.emit('planned:' + wrappedTask.id, result);
          this.emit('planned', wrappedTask.id, result);
        },
        (err) => {
          logic(
            this, 'planning:end',
            { success: false, err, task: wrappedTask });
          this.emit('planned:' + wrappedTask.id, null);
          this.emit('planned', wrappedTask.id, null);
        });
    } else {
      logic(this, 'planning:end', { moot: true, task: wrappedTask });
      this.emit('planned:' + wrappedTask.id, undefined);
      this.emit('planned', wrappedTask.id, undefined);
    }
    return planResult;
  },

  _executeNextTask() {
    let taskThing = this._priorities.popNextAvailableTask();
    logic(this, 'executing:begin', { task: taskThing });

    let ctx = new TaskContext(taskThing, this._universe);
    let execResult = this._registry.executeTask(ctx, taskThing);
    if (execResult) {
      execResult.then(
        (maybeResult) => {
          let result = maybeResult && maybeResult.wrappedResult || undefined;
          logic(this, 'executing:end', { success: true, task: taskThing });
          this.emit('executed:' + taskThing.id, result);
          this.emit('executed', taskThing.id, result);
        },
        (err) => {
          logic(
            this, 'executing:end',
            { success: false, err, task: taskThing });
          this.emit('executed:' + taskThing.id, null);
          this.emit('executed', taskThing.id, null);
        });
    } else {
      logic(this, 'executing:end', { moot: true, task: taskThing });
      this.emit('executed:' + taskThing.id, undefined);
      this.emit('executed', taskThing.id, undefined);
    }
    return execResult;
  },

  /**
   * Used by `TaskContext.spawnSubtask` to tell us about subtasks it is
   * spawning.  From a scheduling/management/ownership perspective, we don't
   * care about them at all.  But from a logging perspective we do care and
   * we want them to pass through us.
   *
   * Currently we are treating subtasks very explicitly to logging as their own
   * thing and not pretending they are tasks being executed.  Likewise, we do
   * not expose them to task groups, etc.  The rationale is that subtasks'
   * life-cycles are strictly bound by their parent tasks, so they are boring on
   * their own.  (Also, they're basically just a hack to reuse all the
   * read/mutate/lock semantics while still maintaining our rules about
   * locking.)
   *
   * @param {TaskContext} subctx
   *   The task context created for the subtask.
   * @param {Function} subtaskFunc
   *   The subtask function to be invoked and which is expected to return a
   *   Promise (presumably the function is wrapped using co.wrap()).  We use
   *   subctx.__taskInstance as the `this`, the `subctx` as the first argument,
   *   and the `subtaskArg` as the second argument.
   * @param Object [subtaskArg]
   */
  __trackAndWrapSubtask(ctx, subctx, subtaskFunc, subtaskArg) {
    logic(this, 'subtask:begin', { taskId: ctx.id, subtaskId: subctx.id });
    let subtaskResult =
      subtaskFunc.call(subctx.__taskInstance, subctx, subtaskArg);
    // (we want our logging to definitely happen before any result is returned)
    return subtaskResult.then((result) => {
      logic(this, 'subtask:end', { taskId: ctx.id, subtaskId: subctx.id });
      return result;
    });
  }
});

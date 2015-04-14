define(function(require) {

let co = require('co');
let logic = require('logic');

let TaskDefiner = require('./task_definer');
let TaskContext = require('./task_context');

let FibonacciHeap = require('./ext/fibonacci-heap');

let DEFAULT_PRIORITY = 100;

function TaskManager(universe, db) {
  logic.defineScope(this, 'TaskManager');
  this._universe = universe;
  this._db = db;
  this._registry = TaskDefiner;

  // XXX SADNESS.  So we wanted to use autoincrement to avoid collisions or us
  // having to manage a counter.  Unfortunately, we want to use mozGetAll for
  // retrieval, but that can't include the keys, so we need to always have
  // the key inside the value.  To avoid managing the counter we go with a
  // strategy to avoid colliding keys, probably.  We use Date.now and then
  // assume that we won't generate tasks at a sustainted rate of more than 100
  // tasks per millisecond (on average).
  let idBase = (Date.now() - 1400000000000);
  if (idBase < 0) {
    throw new Error('clock is bad, correctness compromised, giving up.')
  }
  this._nextId = idBase * 100;

  /**
   * @type{Array<RawTask>}
   * The tasks that we still need to plan (but have scheduled/durably persisted
   * to disk.)
   */
  this._tasksToPlan = [];

  this._prioritizedTasks = new FibonacciHeap();

  this._activePromise = null;
}
TaskManager.prototype = {
  __restoreFromDB: co.wrap(function*() {
    let wrappedTasks = yield this._db.loadTasks();
    logic(this, 'restoreFromDB', { count: wrappedTasks.length });
    for (let wrappedTask of wrappedTasks) {
      if (wrappedTask.state === null) {
        this._tasksToPlan.push(wrappedTask);
      } else {
        this.__prioritizeTask(wrappedTask);
      }
    }
    this._maybeDoStuff();
  }),

  /**
   * Schedule one or more tasks.  Resolved with the ids of the task once they
   * have been durably persisted to disk.  You should not care about the id
   * unless you are a unit test.  For all user-visible things, you should be
   * listening on a list view or a specific object identifier, etc.  (Ex: if you
   * care about an attachment being downloaded, listen to the message itself or
   * view the list of pending downloads.)
   *
   * This method should only be called by things that are not part of the task
   * system, like user-triggered actions.  Tasks should list the tasks they
   * define during their call to finishTask.
   *
   * @param {String} why
   *   Human readable but terse label to explain the causality/rationale of this
   *   task being scheduled.
   */
  scheduleTasks: function(rawTasks, why) {
    let wrappedTasks = this._wrapTasks(rawTasks);

    logic(this, 'scheduling', { why: why, tasks: wrappedTasks });

    return this._db.addTasks(wrappedTasks).then(() => {
      this.__enqueuePersistedTasksForPlanning(wrappedTasks);
    });
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
    this._tasksToPlan.splice(this._tasksToPlan.length, 0, ...wrappedTasks);
    this._maybeDoStuff();
  }

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
    } else if (!this._prioritizedTasks.isEmpty()) {
      this._activePromise = this._executeNextTask();
    } else {
      logic(this, 'nothingToDo');
    }

    if (!this._activePromise) {
      return;
    }

    this._activePromise.then(() => {
      this._activePromise = null;
      logic(this, 'completed');
      this._maybeDoStuff();
    }, (err) => {
      this._activePromise = null;
      logic(this, 'taskFailure', { err: err, stack: err.stack });
      this._maybeDoStuff();
    });
  },

  /**
   * Plan the next task.  This task will advance to 'planned' atomically as part
   * of the completion of planning.  In the case of simple tasks, this will
   * happen via a call to `__prioritizeTask`, but for complex tasks other stuff
   * may happen.
   */
  _planNextTask: function() {
    let wrappedTask = this._tasksToPlan.shift();
    logic(this, 'planning', { task: wrappedTask });
    let ctx = new TaskContext(wrappedTask, this._universe);
    return this._registry.__planTask(ctx, wrappedTask);
  },

  __prioritizeTask: function(wrappedTask) {
    logic(this, 'prioritizing', { task: wrappedTask });
    if (!wrappedTask.priority) {
      wrappedTask.priority = DEFAULT_PRIORITY;
    }
    this._prioritizedTasks.insert(wrappedTask.priority,
                                  wrappedTask);
    // If nothing is happening, then we might need/want to call _maybeDoStuff
    // soon, but not until whatever's calling us has had a chance to finish.
    // And if something is happening, well, we already know we will call
    // _maybeDoStuff when that happens.  (Note that we must not call
    // _maybeDoStuff synchronously because _maybeDoStuff may already be on the
    // stack, waiting for a promise to be returned to it.)
    // XXX Audit this more and potentially ensure there's only one of these
    // nextTick-style hacks.  But right now this should be harmless but
    // wasteful.
    if (!this._activePromise) {
      Promise.resolve().then(() => {
        this._maybeDoStuff();
      });
    }
  },

  _executeNextTask: function() {
    let wrappedTask = this._prioritizedTasks.extractMinimum().value;
    logic(this, 'executing', { task: wrappedTask });
    let ctx = new TaskContext(wrappedTask, this._universe);
    return this._registry.__executeTask(ctx, wrappedTask);
  }
};

return TaskManager;
});

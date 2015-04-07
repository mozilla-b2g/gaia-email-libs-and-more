define(function(require) {

let co = require('co');

let TaskDefiner = require('./task_definer');
let TaskContext = require('./task_context');

let FibonacciHeap = require('./ext/fibonacci-heap');

function TaskManager(universe, db) {
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
    for (let wrappedTask of wrappedTasks) {
      if (wrappedTask.state === null) {
        this._tasksToPlan.push(wrappedTask);
      } else {
        this._prioritizedTask.insert(wrappedTask.priority, wrappedTask)
      }
    }
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
   */
  scheduleTasks: function(rawTasks) {
    let wrappedTasks = rawTasks.map((rawTask) => {
      return {
        id: this._nextId++,
        rawTask: rawTask,
        state: null // => planned => (deleted)
      };
    });

    return this._db.addTasks(wrappedTasks).then(() => {
      this._tasksToPlan.splice(this._tasksToPlan.length, 0, ...wrappedTasks);
    });

    return Promise.all(rawTasks.map(x => this.scheduleTask(x)));
  },

  _maybeDoStuff: function() {
    if (this._activePromise) {
      return;
    }

    if (this._tasksToPlan.length) {
      this._activePromise = task._planNextTask();
    } else if (!this._prioritizedTasks.isEmpty()) {
      this._activePromise = task._executeNextTask();
    }

    if (!this._activePromise) {
      return;
    }

    this._activePromise.then(() => {
      this._activePromise = null;
      this._maybeDoStuff();
    });
  },

  _planNextTask: function() {
    let wrappedTask = this._tasksToPlan.shift();
    let ctx = new TaskContext(wrappedTask, this._universe);
    return this._registry.__planTask(ctx, wrappedTask);
  },

  _executeNextTask: function() {
    let wrappedTask = this._prioritizedTasks.extractMinimum();
    let ctx = new TaskContext(wrappedTask, this._universe);

    return this._registry.__executeTask(ctx, wrappedTask);
  }
};

return TaskManager;
});

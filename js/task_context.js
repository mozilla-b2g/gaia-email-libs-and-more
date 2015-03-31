define(function (require) {

let logic = require('./logic');

/**
 * Provides helpers and standard arguments/context for tasks.
 */
function TaskContext(id, args) {
  logic.defineScope(this, 'TaskContext', { id: id, accountId: args.accountId });
  this.id = id;
  this.account = args.account;
  this._db = args.db;

  this._stuffToRelease = [];
  this._preMutateStates = null;

  /**
   * @type {'prep'|'mutate'|'finishing'}
   */
   this.state = 'prep';
}
TaskContext.prototype = {
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

  read: function(what) {
    return this._db.read(this, what);
  },

  beginMutate: function(what) {
    if (this.state !== 'prep') {
      throw new Error(
        'Cannot switch to mutate state from state: ' + this.state);
    }
    this.state = 'mutate';
    return this._db.beginMutate(this, what);
  },

  /**
   * @param {Object} finishData
   * @param {Object} finishData.mutations
   *   The mutations to finish as a result of the one preceding call to
   *   `beginMutate`.
   * @param {Object} finishData.newData
   *   New records being added to the database.
   * @param {Array<RawTask>} finishData.newTasks
   *   The new tasks that should be atomically, persistently tracked as a
   *   deterministic result of this task.
   */
  finishTask: function(finishData) {
    this.state = 'finishing';
  },

  // XXX do auto-fancy log thing
  log: function(type, data) {
    if (data) {
      data.taskId = this.id;
    } else {
      data = { taskId: this.id };
    }
    slog.log(type, data);
  }
};
return TaskContext;
});

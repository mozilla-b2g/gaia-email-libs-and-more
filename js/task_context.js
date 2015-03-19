define(function (require) {

let slog = require('./slog');

/**
 * Provides helpers and standard arguments/context for tasks.
 */
function TaskContext(id, args) {
  this.id = id;
  this.account = args.account;
  this._db = args.db;

  this._stuffToRelease = [];
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

  read: function(what) {
    return this._db.read(this, what);
  },

  beginMutate: function(what) {
    return this._db.beginMutate(this, what);
  },

  finishTask: function(mutations, newTasks) {

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

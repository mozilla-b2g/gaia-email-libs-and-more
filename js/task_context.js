define(function (require) {

/**
 * Provides helpers and standard arguments/context for tasks.
 */
function TaskContext() {
  this._stuffToRelease = [];
}
TaskContext.prototype = {
  /**
   * Asynchronously acquire a resource and track that we are using it so that
   * when the task completes or is terminated we can automatically release all
   * acquired resources.
   */
  acquire: function(acquireable) {

  }
};
return TaskContext;
});

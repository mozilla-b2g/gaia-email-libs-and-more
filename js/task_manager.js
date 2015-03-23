define(function(require) {

function TaskManager(db) {
  this._db = db;
  /**
   * @typedef {Object} TaskToScheduleRec
   * @property {Object} rawTask
   * @property {Function} resolve
   *   The function to use to resolve the Promise.
   */
  /**
   * @type{Array<TaskToScheduleRec>}
   * The list of tasks that scheduleTask has been call
   */
  this._tasksToSchedule = [];

  /**
   * @type{Array<RawTask>}
   * The tasks that we still need to plan.
   */
  this._tasksToPlan = [];
}
TaskManager.prototype = {
  /**
   * Schedule a task.  Resolved with the id of the task once it has been durably
   * persisted to disk.  You should not care about the id unless you are a unit
   * test.  For all user-visible things, you should be listening on a list view
   * or a specific object identifier, etc.  (Ex: if you care about an attachment
   * being downloaded, listen to the message itself or view the list of pending
   * downloads.)
   *
   * This method should only be called by things that are not part of the task
   * system, like user-triggered actions.  Tasks should list the tasks they
   * define during their call to finishTask.
   */
  scheduleTask: function(rawTask) {

    return new Promise((resolve, reject) => {
      this._tasksToSchedule
    });
  },

  /**
   * Conceptually, calls scheduleTask a bunch for you and wraps them up in a
   * Promise.all.  (scheduleTask is actually implemented in terms of this one.)
   */
  scheduleTasks: function(rawTasks) {
    return Promise.all(rawTasks.map(x => this.scheduleTask(x)));
  }
};

return TaskManager;
});

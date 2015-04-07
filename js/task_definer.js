define(function(require) {

let mix = require('mix');

let SimpleTaskBase = {
  plan: null,
  execute: null,
};

function TaskDefiner() {
  this._registry = new Map();
}
TaskDefiner.prototype = {
  __planTask: function(ctx, wrappedTask) {
    let rawTask = wrappedTask.rawTask;
    let taskImpl = this._registry.get(rawTask.type);

    if (!taskImpl.plan) {
      return Promise.resolve();
    }

    return taskImpl.plan(ctx, rawTask);
  },

  __executeTask: function(ctx, wrappedTask) {
    let rawTask = wrappedTask.rawTask;
    let taskImpl = this._registry.get(rawTask.type);

    if (!taskImpl.execute) {
      return Promise.resolve();
    }

    return taskImpl.execute(ctx, rawTask);
  },


  /**
   * Define a task that's fully characterized by its name an arguments and along
   * with some other simple configuration, the task infrastructure is able to
   * handle all the state management.
   */
  defineSimpleTask: function(mixparts) {
    let task = {};
    mix(task, SimpleTaskBase, true);
    for (let part of mixparts) {
      mix(task, part, true);
    }

    this._registry.set(task.name, task);
  },

  /**
   * Define a task that maintains its own aggregate state and handles all task
   * mooting, unification, etc.
   */
  defineComplexTask: function(mixparts) {

  }
};

return new TaskDefiner();
});

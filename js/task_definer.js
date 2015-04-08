define(function(require) {

let co = require('co');
let mix = require('mix');

let SimpleTaskBase = {
  /**
   * No-op planning phase that just handles prioritization.
   */
  plan: co.wrap(function*(ctx, rawTask) {
    yield ctx.finishTask({
      // Just pass the raw task state through, as-is
      taskState: rawTask
    });
  }),
  execute: null,
};

function TaskDefiner() {
  this._registry = new Map();
}
TaskDefiner.prototype = {
  __planTask: function(ctx, wrappedTask) {
    let rawTask = wrappedTask.rawTask;
    let taskImpl = this._registry.get(rawTask.type);

    // All tasks have a plan stage.  Even if it's only the default one that
    // just chucks it in the priority bucket.
    return taskImpl.plan(ctx, rawTask);
  },

  __executeTask: function(ctx, wrappedTask) {
    let plannedTask = wrappedTask.plannedTask;
    let taskImpl = this._registry.get(plannedTask.type);

    if (!taskImpl.execute) {
      return Promise.resolve();
    }

    return taskImpl.execute(ctx, plannedTask);
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

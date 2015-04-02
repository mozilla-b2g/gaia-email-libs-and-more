define(function(require) {

let SimpleTaskBase = {
  
};

function TaskDefiner() {

}
TaskDefiner.prototype = {
  /**
   * Define a task that's fully characterized by its name an arguments and along
   * with some other simple configuration, the task infrastructure is able to
   * handle all the state management.
   */
  defineSimpleTask: function(mixparts) {

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

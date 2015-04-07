define(function(require) {

let TaskDefiner = require('../../task_definer');

return TaskDefiner.defineComplexTask([
  require('./mix_store'),
  {
    name: 'store_labels',
  }
]);

});

define(function(require) {
'use strict';

let TaskDefiner = require('../../task_infra/task_definer');

/**
 * We use the vanilla IMAP store flags implementation without any execute stage
 * since everything is just local.  We just have the mix-in conditionalize its
 * state accumulation on execute being non-null since the code doesn't get too
 * messy.
 *
 * @see MixStoreFlagsMixin
 */
return TaskDefiner.defineComplexTask([
  require('../../task_mixins/mix_store_flags'),
  {
    name: 'store_flags',

    execute: null
  }
]);
});

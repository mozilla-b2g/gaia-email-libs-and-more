define(function(require) {
'use strict';

const co = require('co');
const TaskDefiner = require('../task_infra/task_definer');

const autoconfigLookup = require('../autoconfig/autoconfig_lookup');

/**
 * This is a thin shim around autoconfigLookup to run it under the task
 * infrastructure.
 *
 * Please see the MailAPI docs on `learnAboutAccount` for more information.
 */
return TaskDefiner.defineSimpleTask([
  {
    name: 'account_autoconfig',

    exclusiveResources: function() {
      return [
      ];
    },

    priorityTags: function() {
      return [
      ];
    },

    execute: co.wrap(function*(ctx, planned) {
      // Run autoconfig.
      let result = yield autoconfigLookup(planned.userDetails);
      // Formally complete the task.
      yield ctx.finishTask({});
      // Return the autoconfig result.
      return ctx.returnValue(result);
    })
  }
]);
});

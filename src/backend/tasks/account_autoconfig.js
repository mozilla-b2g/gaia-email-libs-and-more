import TaskDefiner from '../task_infra/task_definer';

import autoconfigLookup from '../autoconfig/autoconfig_lookup';

/**
 * This is a thin shim around autoconfigLookup to run it under the task
 * infrastructure.
 *
 * Please see the MailAPI docs on `learnAboutAccount` for more information.
 */
export default TaskDefiner.defineSimpleTask([
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

    async execute(ctx, planned) {
      // Run autoconfig.
      let result = await autoconfigLookup(planned.userDetails);
      // Formally complete the task.
      await ctx.finishTask({});
      // Return the autoconfig result.
      return ctx.returnValue(result);
    },
  }
]);

import TaskDefiner from '../task_infra/task_definer';

/**
 * Account migration via account re-creation during the planning phase.
 *
 * This covers database schema changes where the account definition has not
 * changed (but other things have), so we can get away with just re-saving the
 * account definition to disk.
 *
 * This implementation assumes that the MailUniverse.init method is continuing
 * to propagate the nextAccountNum from the old config.
 */
export default TaskDefiner.defineSimpleTask([
  {
    name: 'account_migrate',

    async plan(ctx, raw) {
      let { accountDef } = raw;

      await ctx.finishTask({
        newData: {
          accounts: [accountDef]
        }
      });
    },

    execute: null
  }
]);

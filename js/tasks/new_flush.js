import TaskDefiner from '../task_infra/task_definer';

import churnAllNewMessages from 'app_logic/new_batch_churn';

/**
 * This task gathers up the new_tracking data from all accounts, feeds it to the
 * new_batch_churn, and sends the result over the wire to the frontend as a
 * broadcast.
 *
 * This task is automatically enqueued for scheduling when the root task group
 * of a task that modifies the newness state completes or when the new_tracking
 * state is explicitly cleared.  This means that this task happens magically
 * and you do not need to schedule it yourself.
 */
export default TaskDefiner.defineAtMostOnceTask([
  {
    name: 'new_flush',
    // This will cause us to use the bin 'only' at all times.
    binByArg: null,

    async helped_plan(ctx/*, rawTask*/) {
      // -- Get the list of all accounts
      // grab the TOC and use getAllItems to get the bridge wire-protocol rep
      // because we expose the account info objects to the app logic and it's
      // arguably safer/simpler for us to provide that rather than the full
      // accountDef.
      const accountsTOC = await ctx.acquireAccountsTOC();
      const accountInfos = accountsTOC.getAllItems();

      // -- For each account, consult the new_tracking task to get the data
      const newSetsWithAccount = [];
      for (let accountInfo of accountInfos) {
        let newByConv = ctx.synchronouslyConsultOtherTask(
          {
            name: 'new_tracking',
            accountId: accountInfo.id
          });
        newSetsWithAccount.push({
          accountInfo,
          newByConv
        });
      }

      // -- Have the app logic churn
      let churned = await churnAllNewMessages(ctx, newSetsWithAccount);

      // -- Send the result over the bridge.
      ctx.broadcastOverBridges('newMessagesUpdate', churned);

      // -- All done
      return {
        taskState: null
      };
    },
  }
]);

import TaskDefiner from '../task_infra/task_definer';

/**
 * Delete an account.
 *
 * This is a somewhat complicated/special-case type of thing.  Our main goals
 * are to:
 * - Make sure the TOC that tracks accounts has the account removed.
 * - Remove all the stuff in the database and ensure that there's no in-memory
 *   state that could make things in the database come back into existence.  So
 *   this means:
 *   - deleting the ranges covering the conversations, headers, and bodies
 *   - ensuring all planned tasks associated with our account are killed/mooted
 *     by the time we complete.  TODO: have planning this task trigger a mooting
 *     of all related tasks.
 *   - ensuring that all queued unplanned/raw tasks will fail to plan in the
 *     future because the account no longer exists.  TODO: handle by having
 *     task planning depend on knowing all existing accounts and refusing to
 *     plan tasks that do not correspond to an existing account.  This should
 *     generally fine because we load accountDefs as part of our initial
 *     database load.
 * - In the future when we support cross-account things like unified inbox
 *   views, we need to ensure that the conversations from the account are
 *   retracted.
 *
 * Things that the back-end could do more about but it's not clear it's
 * something we need to address yet:
 * - Dealing with now-moot TOC's for things like the contents of a folder
 *   associated with the deleted account or a conversation from that account.
 *   A single UI triggering account deletion should arguably be dealing with the
 *   direct ramifications, but if multiple UI's are present, then it gets
 *   more tricky.  (In the cross-account case with unified inbox, we do need
 *   propagating notifications about the retraction of the folder, etc.)
 *
 *
 * TODO: This should probably moot most of the tasks associated with the
 * account.
 */
export default TaskDefiner.defineSimpleTask([
  {
    name: 'account_delete',
    args: ['accountId'],

    exclusiveResources: function(args) {
      return [
        `account:${args.accountId}`
      ];
    },

    priorityTags: function() {
      return [
      ];
    },

    async execute(ctx, planned) {
      // Acquire a write-lock on the account so we can delete it.
      await ctx.beginMutate({
        accounts: new Map([[planned.accountId, null]])
      });

      await ctx.finishTask({
        mutations: {
          accounts: new Map([[planned.accountId, null]])
        }
      });
    }
  }
]);

import logic from 'logic';
import TaskDefiner from '../task_infra/task_definer';

/**
 * Manipulate identity settings.  Right now we only support one identity per
 * account and we hard-code the path, though it wouldn't take much to
 */
export default TaskDefiner.defineSimpleTask([
  {
    name: 'config_modify',

    async plan(ctx, rawTask) {
      // Access the account for read-only consultation.  Because we don't need
      // to wait on any network access and because of how things actually work,
      // we could absolutely acquire this for write mutation and do an explicit
      // write.  However, by using the clobber mechanism we are able to have
      // prettier/more explicit logging and also have unit tests that more
      // directly ensure what we're doing in here is correct as it relates to
      // to our conditionalized username/password logic.
      const accountClobbers = new Map();

      for (let key in rawTask.mods) {
        const val = rawTask.mods[key];

        switch (key) {
          case 'debugLogging':
            accountClobbers.set(['debugLogging'], val);
            break;

          default:
            logic(ctx, 'badModifyConfigKey', { key });
            break;
        }
      }

      await ctx.finishTask({
        atomicClobbers: {
          config: new Map([
            [
              rawTask.accountId,
              accountClobbers
            ]
          ])
        }
      });
    }
  }
]);

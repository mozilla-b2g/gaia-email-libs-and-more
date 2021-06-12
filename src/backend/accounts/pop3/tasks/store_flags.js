import TaskDefiner from '../../../task_infra/task_definer';

import MixinStoreFlags from '../../../task_mixins/mix_store_flags';

/**
 * We use the vanilla IMAP store flags implementation without any execute stage
 * since everything is just local.  We just have the mix-in conditionalize its
 * state accumulation on execute being non-null since the code doesn't get too
 * messy.
 *
 * @see MixStoreFlagsMixin
 */
export default TaskDefiner.defineComplexTask([
  MixinStoreFlags,
  {
    name: 'store_flags',

    execute: null
  }
]);

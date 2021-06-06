import TaskDefiner from '../../../task_infra/task_definer';

import { applyChanges } from '../../../delta_algebra';

import MixinSyncConv from '../../../task_mixins/mix_sync_conv';

/**
 * Planning-only task that applies modifications to a conversation based on
 * other sync logic.
 */
export default TaskDefiner.defineSimpleTask([
  MixinSyncConv,
  {
    name: 'sync_conv',

    applyChanges: function(message, flagChanges) {
      applyChanges(message.flags, flagChanges);
    },
  }
]);

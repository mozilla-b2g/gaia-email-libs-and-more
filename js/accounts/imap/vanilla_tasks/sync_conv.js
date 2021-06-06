import TaskDefiner from '../../../task_infra/task_definer';

import MixSyncConv from '../../../task_mixins/mix_sync_conv';

/**
 * Planning-only task that applies modifications to a conversation based on
 * other sync logic.
 */
export default TaskDefiner.defineSimpleTask([
  MixSyncConv,
  {
    name: 'sync_conv',

    applyChanges(message, newFlags) {
      message.flags = newFlags;
    },
  }
]);

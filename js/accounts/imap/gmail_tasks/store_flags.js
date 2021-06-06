import TaskDefiner from '../../../task_infra/task_definer';

import MixinStore from './mix_store';

export default TaskDefiner.defineComplexTask([
  MixinStore,
  {
    name: 'store_flags',
    attrName: 'flags',
    // We don't care about the fetch return, so don't bother.
    imapDataName: 'FLAGS.SILENT',

    prepNormalizationLogic: function(/*ctx, accountId*/) {
      return Promise.resolve(null);
    },

    normalizeLocalToServer: function(ignored, flags) {
      return flags;
    }
  }
]);

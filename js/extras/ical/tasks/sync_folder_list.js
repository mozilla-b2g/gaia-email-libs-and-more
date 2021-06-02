import TaskDefiner from '../../../task_infra/task_definer';

import MixinSyncFolderList from '../../../task_mixins/mix_sync_folder_list';

/**
 *
 */
export default TaskDefiner.defineSimpleTask([
  MixinSyncFolderList,
  {
    essentialOfflineFolders: [
      {
        type: 'inbox',
        displayName: 'Events'
      },
    ],

    /**
     * There really isn't anything for us to do at this time.
     */
    async syncFolders(/*ctx, account*/) {
      return {
        newFolders: undefined,
        newTasks: undefined,
        modifiedFolders: undefined,
        modifiedSyncStates: undefined,
      };
    }
  }
]);

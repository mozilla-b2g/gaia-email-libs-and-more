import TaskDefiner from '../../../task_infra/task_definer';

import MixinSyncFolderList from '../../../task_mixins/mix_sync_folder_list';

/**
 * Sync the folder list for an ActiveSync account.  We leverage IMAP's mix-in
 * for the infrastructure (that wants to move someplace less IMAPpy.)
 */
export default TaskDefiner.defineSimpleTask([
  MixinSyncFolderList,
  {
    essentialOfflineFolders: [
      {
        type: 'inbox',
        displayName: 'Inbox'
      },
      // Eventually we presumably could support modifications, so just leave
      // this around so nothing freaks out.
      {
        type: 'outbox',
        displayName: 'outbox'
      },
      // And this goes hand-in-hand with that.
      {
        type: 'localdrafts',
        displayName: 'localdrafts'
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

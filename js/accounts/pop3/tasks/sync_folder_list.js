import TaskDefiner from '../../../task_infra/task_definer';

import MixinSyncFolderList from '../../../task_mixins/mix_sync_folder_list';

/**
 * Create the POP3 offline-only folders.
 */
export default TaskDefiner.defineSimpleTask([
  MixinSyncFolderList,
  {
    essentialOfflineFolders: [
      // Note that versus IMAP, our inbox is offline.
      {
        type: 'inbox',
        displayName: 'Inbox'
      },
      {
        type: 'outbox',
        displayName: 'outbox'
      },
      {
        type: 'localdrafts',
        displayName: 'localdrafts'
      },
      // pop3-specific that would normally be online folders
      {
        type: 'trash',
        displayName: 'trash'
      },
      {
        type: 'sent',
        displayName: 'sent'
      }
    ],

    // We have no online component.
    execute: null
  }
]);

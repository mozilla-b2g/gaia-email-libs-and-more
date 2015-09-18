define(function(require) {
'use strict';

const TaskDefiner = require('../../task_definer');

/**
 * Create the POP3 offline-only folders.
 */
return TaskDefiner.defineSimpleTask([
  require('../../imap/vanilla_tasks/mix_sync_folder_list'),
  {
    essentialOfflineFolders: [
      // (these are the same as in mix_sync_folder_list)
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
});

define(function(require) {
'use strict';

const TaskDefiner = require('../../task_definer');

/**
 * Create the POP3 offline-only folders.
 */
return TaskDefiner.defineSimpleTask([
  require('../../imap/vanilla_tasks/mix_sync_folder_list'),
  {
    // We have no online component.  We just need ensureEssentialOfflineFolders
    // to be called.
    execute: null
  }
]);
});

define(function(require) {
'use strict';

const TaskDefiner = require('../../task_definer');

/**
 * Common IMAP folder list syncing logic.
 */
return TaskDefiner.defineSimpleTask([
  require('./mix_sync_folder_list'),
  {
    syncFolders: function*(ctx, account) {
      let imapAccount = account.imapAccount;

      let boxesRoot = yield imapAccount.pimap.listMailboxes();
      let namespaces = yield imapAccount.pimap.listNamespaces();

      imapAccount.processFolderListUpdates(boxesRoot, namespaces);
    }
  }
]);
});

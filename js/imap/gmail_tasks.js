define(function(require) {
'use strict';

/**
 * These are the tasks for gmail accounts.
 */
return [
  require('./imap/tasks/sync_folder_list'),

  require('./imap/tasks/sync_grow'),
  require('./imap/tasks/sync_refresh'),
  require('./imap/tasks/sync_conv'),
  require('./imap/tasks/sync_body'),

  require('./imap/tasks/store_flags'),
  require('./imap/tasks/store_labels')
];
});

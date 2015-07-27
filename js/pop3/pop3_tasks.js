define(function(require) {
'use strict';

/**
 * Standard IMAP.
 */
return [
  require('./tasks/sync_folder_list'),

  require('./tasks/sync_grow'),
  require('./tasks/sync_refresh'),
  require('./tasks/sync_message'),
  require('./tasks/sync_body'),

  require('./tasks/store_flags')
];
});

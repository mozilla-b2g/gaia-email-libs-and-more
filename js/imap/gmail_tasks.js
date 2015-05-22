define(function(require) {
'use strict';

/**
 * These are the tasks for gmail accounts.
 */
return [
  require('./tasks/sync_folder_list'),

  require('./tasks/sync_grow'),
  require('./tasks/sync_refresh'),
  require('./tasks/sync_conv'),
  require('./tasks/sync_body'),

  require('./tasks/store_flags'),
  require('./tasks/store_labels')
];
});

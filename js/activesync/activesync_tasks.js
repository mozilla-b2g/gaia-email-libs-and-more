define(function(require) {
'use strict';

/**
 * Standard IMAP.
 */
return [
  require('./tasks/sync_folder_list'),

  // ActiveSync has no need for refresh.  But maybe we want a stub?
  //require('./tasks/sync_grow'),
  require('./tasks/sync_refresh'),
  require('./sync_conv'),
  require('./sync_body'),

  require('./vanilla_tasks/store_flags')
];
});

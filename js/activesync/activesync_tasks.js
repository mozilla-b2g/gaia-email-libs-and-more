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
  require('./tasks/sync_conv'),
  require('./tasks/sync_body'),

  require('./tasks/store_flags')
];
});

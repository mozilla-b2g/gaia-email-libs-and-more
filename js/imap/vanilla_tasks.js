define(function(require) {
'use strict';

/**
 * Standard IMAP.
 */
return [
  require('./vanilla_tasks/sync_folder_list'),

  require('./vanilla_tasks/sync_grow'),
  require('./vanilla_tasks/sync_refresh'),
  require('./vanilla_tasks/sync_message'),
  require('./vanilla_tasks/sync_conv'),
  require('./vanilla_tasks/sync_body'),
  //require('./vanilla_tasks/merge_conversations'),

  require('./vanilla_tasks/store_flags')
];
});

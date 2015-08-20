define(function(require) {
'use strict';

/**
 * These are the tasks for gmail accounts.
 */
return [
  require('./vanilla_tasks/sync_folder_list'),

  require('./gmail_tasks/sync_grow'),
  require('./gmail_tasks/sync_refresh'),
  require('./gmail_tasks/sync_conv'),
  require('./gmail_tasks/sync_body'),

  require('./gmail_tasks/store_flags'),
  require('./gmail_tasks/store_labels'),

  require('../tasks/draft_save'),
  require('../tasks/draft_attach'),
  require('../tasks/draft_detach'),
  require('../tasks/draft_delete'),
  require('./gmail_tasks/outbox_send')
];
});

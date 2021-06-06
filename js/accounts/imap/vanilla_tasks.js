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

  require('./vanilla_tasks/download'),

  require('./vanilla_tasks/store_flags'),

  require('../tasks/draft_save'),
  require('../tasks/draft_attach'),
  require('../tasks/draft_detach'),
  require('../tasks/draft_delete'),
  require('./vanilla_tasks/outbox_send'),

  require('./vanilla_tasks/append_message'),

  require('../tasks/account_modify'),
  require('../tasks/identity_modify'),

  require('../tasks/new_tracking'),
];
});

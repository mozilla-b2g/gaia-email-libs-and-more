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

  require('./tasks/store_flags'),

  require('../tasks/draft_save'),
  require('../tasks/draft_attach'),
  require('../tasks/draft_detach'),
  require('../tasks/draft_delete'),
  require('./tasks/outbox_send'),

  require('../tasks/account_modify'),
  require('../tasks/identity_modify'),

  require('../tasks/new_tracking'),
];
});

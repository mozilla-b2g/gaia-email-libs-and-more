define(function(require) {
'use strict';

/**
 * Global tasks which aren't associated with a specific account type.
 */
return [
  // - Account management
  require('./tasks/delete_account'),

  // - Drafts
  require('./tasks/draft_create'),
  require('./tasks/draft_save'),
  require('./tasks/draft_attach'),
  require('./tasks/draft_detach'),
  require('./tasks/draft_discard'),
  require('./tasks/outbox_send'), // handles "send this" and "oh no, stop!"

];
});

define(function(require) {
'use strict';

/**
 * Global tasks which aren't associated with a specific account type.
 */
return [
  // - Account management
  require('./tasks/account_autoconfig'),
  require('./tasks/account_create'),
  require('./tasks/account_delete'),
  require('./tasks/account_migrate'),

  // - Drafts
  require('./tasks/draft_create'),
  // (All other drafts tasks are per-account even though they use the same
  // global implementations.)

  // - Aggregate state stuff
  require('./tasks/new_flush')
];
});

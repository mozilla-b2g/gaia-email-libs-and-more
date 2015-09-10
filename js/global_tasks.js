define(function(require) {
'use strict';

/**
 * Global tasks which aren't associated with a specific account type.
 */
return [
  // - Account management
  require('./tasks/account_create_autoconfig'),
  require('./tasks/account_create_manual'),
  require('./tasks/account_migrate'),
  require('./tasks/account_delete'),

  // - Drafts
  require('./tasks/draft_create'),
];
});

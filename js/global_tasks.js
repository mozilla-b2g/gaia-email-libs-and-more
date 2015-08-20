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
];
});

import AccountAutoconfig from './tasks/account_autoconfig';
import AccountCreate from './tasks/account_create';
import AccountDelete from './tasks/account_delete';
import AccountMigrate from './tasks/account_migrate';
import DraftCreate from './tasks/draft_create';
import NewFlush from './tasks/new_flush';

/**
 * Global tasks which aren't associated with a specific account type.
 */
export default [
  // - Account management
  AccountAutoconfig,
  AccountCreate,
  AccountDelete,
  AccountMigrate,

  // - Drafts
  DraftCreate,

  // (All other drafts tasks are per-account even though they use the same
  // global implementations.)

  // - Aggregate state stuff
  NewFlush,
];


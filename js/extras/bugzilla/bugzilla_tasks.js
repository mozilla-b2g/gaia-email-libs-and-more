import bugzilla_syncFolderList from './tasks/sync_folder_list';

import bugzilla_syncBug from './tasks/sync_bug';
import bugzilla_syncRefresh from './tasks/sync_refresh';

import CommonAccountModify from '../../tasks/account_modify';
import CommonIdentityModify from '../../tasks/identity_modify';

import CommonNewTracking from '../../tasks/new_tracking';

export default [
  bugzilla_syncFolderList,

  bugzilla_syncBug,
  bugzilla_syncRefresh,

  CommonAccountModify,
  CommonIdentityModify,

  CommonNewTracking,
];
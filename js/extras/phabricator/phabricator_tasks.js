import phab_syncFolderList from './tasks/sync_folder_list';

import phab_syncDrev from './tasks/sync_drev';
import phab_syncRefresh from './tasks/sync_refresh';

import CommonAccountModify from '../../tasks/account_modify';
import CommonIdentityModify from '../../tasks/identity_modify';

import CommonNewTracking from '../../tasks/new_tracking';

export default [
  phab_syncFolderList,

  phab_syncDrev,
  phab_syncRefresh,

  CommonAccountModify,
  CommonIdentityModify,

  CommonNewTracking,
];
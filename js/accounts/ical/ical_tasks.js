import ical_syncFolderList from './tasks/sync_folder_list';

import ical_syncUid from './tasks/sync_uid';
import ical_syncRefresh from './tasks/sync_refresh';

import CommonAccountModify from '../../tasks/account_modify';
import CommonIdentityModify from '../../tasks/identity_modify';

import CommonNewTracking from '../../tasks/new_tracking';

export default [
  ical_syncFolderList,

  ical_syncUid,
  ical_syncRefresh,

  CommonAccountModify,
  CommonIdentityModify,

  CommonNewTracking,
];

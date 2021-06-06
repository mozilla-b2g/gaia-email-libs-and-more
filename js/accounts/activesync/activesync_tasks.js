import ActiveSync_SyncFolderList from './tasks/sync_folder_list';

import ActiveSync_SyncRefresh from './tasks/sync_refresh';
import ActiveSync_SyncConv from './tasks/sync_conv';
import ActiveSync_SyncBody from './tasks/sync_body';

import ActiveSync_StoreFlags from './tasks/store_flags';

import CommonDraftSave from '../../tasks/draft_save';
import CommonDraftAttach from '../../tasks/draft_attach';
import CommonDraftDetach from '../../tasks/draft_detach';
import CommonDraftDelete from '../../tasks/draft_delete';
import ActiveSync_OutboxSend from './tasks/outbox_send';

import CommonAccountModify from '../../tasks/account_modify';
import CommonIdentityModify from '../../tasks/identity_modify';

import CommonNewTracking from '../../tasks/new_tracking';

export default [
  ActiveSync_SyncFolderList,

  ActiveSync_SyncRefresh,
  ActiveSync_SyncConv,
  ActiveSync_SyncBody,

  ActiveSync_StoreFlags,

  CommonDraftSave,
  CommonDraftAttach,
  CommonDraftDetach,
  CommonDraftDelete,
  ActiveSync_OutboxSend,

  CommonAccountModify,
  CommonIdentityModify,

  CommonNewTracking,
];

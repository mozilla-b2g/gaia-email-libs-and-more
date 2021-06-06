import Pop3SyncFolderList from './tasks/sync_folder_list';

import Pop3SyncGrow from './tasks/sync_grow';
import Pop3SyncRefresh from './tasks/sync_refresh';
import Pop3SyncMessage from './tasks/sync_message';
import Pop3SyncBody from './tasks/sync_body';

import Pop3StoreFlags from './tasks/store_flags';

import CommonDraftSave from '../../tasks/draft_save';
import CommonDraftAttach from '../../tasks/draft_attach';
import CommonDraftDetach from '../../tasks/draft_detach';
import CommonDraftDelete from '../../tasks/draft_delete';

import Pop3OutboxSend from './tasks/outbox_send';

import CommonAccountModify from '../../tasks/account_modify';
import CommonIdentityModify from '../../tasks/identity_modify';

import CommonNewTracking from '../../tasks/new_tracking';

export default [
  Pop3SyncFolderList,

  Pop3SyncGrow,
  Pop3SyncRefresh,
  Pop3SyncMessage,
  Pop3SyncBody,

  Pop3StoreFlags,

  CommonDraftSave,
  CommonDraftAttach,
  CommonDraftDetach,
  CommonDraftDelete,

  Pop3OutboxSend,

  CommonAccountModify,
  CommonIdentityModify,

  CommonNewTracking,
];

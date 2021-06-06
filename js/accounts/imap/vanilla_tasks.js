/**
 * Standard IMAP.
 **/

 import VanillaSyncFolderList from './vanilla_tasks/sync_folder_list';

 import VanillaSyncGrow from './vanilla_tasks/sync_grow';
 import VanillaSyncRefresh from './vanilla_tasks/sync_refresh';
 import VanillaSyncMessage from './vanilla_tasks/sync_message';
 import VanillaSyncConv from './vanilla_tasks/sync_conv';
 import VanillaSyncBody from './vanilla_tasks/sync_body';

 import VanillaDownload from './vanilla_tasks/download';

 import VanillaStoreFlags from './vanilla_tasks/store_flags';

 import CommonDraftSave from '../../tasks/draft_save';
 import CommonDraftAttach from '../../tasks/draft_attach';
 import CommonDraftDetach from '../../tasks/draft_detach';
 import CommonDraftDelete from '../../tasks/draft_delete';

 import VanillaOutboxSend from './vanilla_tasks/outbox_send';

 import VanillaAppendMessage from './vanilla_tasks/append_message';

 import CommonAccountModify from '../../tasks/account_modify';
 import CommonIdentityModify from '../../tasks/identity_modify';

 import CommonNewTracking from '../../tasks/new_tracking';

 export default [
   VanillaSyncFolderList,

   VanillaSyncGrow,
   VanillaSyncRefresh,
   VanillaSyncMessage,
   VanillaSyncConv,
   VanillaSyncBody,
   // TODO: merge_conversations

   VanillaStoreFlags,

   VanillaDownload,

   CommonDraftSave,
   CommonDraftAttach,
   CommonDraftDetach,
   CommonDraftDelete,

   VanillaOutboxSend,

   VanillaAppendMessage,

   CommonAccountModify,
   CommonIdentityModify,
 
   CommonNewTracking,
 ];

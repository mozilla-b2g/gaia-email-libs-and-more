import { numericUidFromMessageId } from 'shared/id_conversions';

import TaskDefiner from '../../../task_infra/task_definer';

import MixinSyncBody from '../../../task_mixins/mix_sync_body';
import MixinImapSyncBody from '../task_mixins/imap_mix_sync_body';

export default TaskDefiner.defineComplexTask([
  MixinSyncBody,
  MixinImapSyncBody,
  {
    prepForMessages(ctx, account/*, messages*/) {
      // For the gmail case we don't have any meaningful prep to do.
      let allMailFolderInfo = account.getFirstFolderWithType('all');
      return Promise.resolve(allMailFolderInfo);
    },

    getFolderAndUidForMesssage(prepped, account, message) {
      return {
        folderInfo: prepped,
        uid: numericUidFromMessageId(message.id)
      };
    }
  }
]);


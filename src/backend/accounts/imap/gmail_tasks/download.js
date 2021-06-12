import { numericUidFromMessageId } from 'shared/id_conversions';

import TaskDefiner from '../../../task_infra/task_definer';

import MixinDownload from '../../../task_mixins/mix_download';
import MixinImapDownload from '../task_mixins/imap_mix_download';

export default TaskDefiner.defineComplexTask([
  MixinDownload,
  MixinImapDownload,
  {
    getFolderAndUidForMesssage: function(ctx, account, message) {
      return Promise.resolve({
        folderInfo: account.getFirstFolderWithType('all'),
        uid: numericUidFromMessageId(message.id)
      });
    },
  }
]);

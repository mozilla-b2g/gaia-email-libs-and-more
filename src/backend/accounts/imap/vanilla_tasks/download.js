import TaskDefiner from '../../../task_infra/task_definer';

import MixinDownload from '../../../task_mixins/mix_download';
import MixinImapDownload from '../task_mixins/imap_mix_download';

export default TaskDefiner.defineComplexTask([
  MixinDownload,
  MixinImapDownload,
  {
    async getFolderAndUidForMesssage(ctx, account, message) {
      let [folderId, uid] = await ctx.readSingle('umidLocations', message.umid);

      return {
        folderInfo: account.getFolderById(folderId),
        uid
      };
    },
  }
]);


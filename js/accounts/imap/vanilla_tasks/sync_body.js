import TaskDefiner from '../../../task_infra/task_definer';

import MixinSyncBody from '../../../task_mixins/mix_sync_body';
import MixinImapSyncBody from '../task_mixins/imap_mix_sync_body';

export default TaskDefiner.defineComplexTask([
  MixinSyncBody,
  MixinImapSyncBody,
  {
    async prepForMessages(ctx, account, messages) {
      let umidLocations = new Map();
      for (let message of messages) {
        umidLocations.set(message.umid, null);
      }

      // We need to look up all the umidLocations.
      await ctx.read({
        umidLocations
      });

      return umidLocations;
    },

    getFolderAndUidForMesssage(umidLocations, account, message) {
      let [folderId, uid] = umidLocations.get(message.umid);
      return {
        folderInfo: account.getFolderById(folderId),
        uid
      };
    }
  }
]);


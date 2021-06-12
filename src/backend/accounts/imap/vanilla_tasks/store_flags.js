import TaskDefiner from '../../../task_infra/task_definer';

/**
 * @see MixStoreFlagsMixin
 */
export default TaskDefiner.defineComplexTask([
  require('../../../task_mixins/mix_store_flags'),
  {
    name: 'store_flags',
    // We don't care about the fetch return, so don't bother.
    imapDataName: 'FLAGS.SILENT',

    async execute(ctx, persistentState, memoryState, marker) {
      let { umidChanges } = persistentState;

      let changes = umidChanges.get(marker.umid);

      let account = await ctx.universe.acquireAccount(ctx, marker.accountId);

      // -- Read the umidLocation
      let fromDb = await ctx.beginMutate({
        umidLocations: new Map([[marker.umid, null]])
      });

      let [ folderId, uid ] = fromDb.umidLocations.get(marker.umid);
      let folderInfo = account.getFolderById(folderId);

      // -- Issue the manipulations to the server
      if (changes.add && changes.add.length) {
        await account.pimap.store(
          ctx,
          folderInfo,
          [uid],
          '+' + this.imapDataName,
          changes.add,
          { byUid: true });
      }
      if (changes.remove && changes.remove.length) {
        await account.pimap.store(
          ctx,
          folderInfo,
          [uid],
          '-' + this.imapDataName,
          changes.remove,
          { byUid: true });
      }

      // - Success, clean up state.
      umidChanges.delete(marker.umid);

      // - Return / finalize
      await ctx.finishTask({
        complexTaskState: persistentState
      });
    }
  }
]);

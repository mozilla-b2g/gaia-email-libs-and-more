define(function(require) {

var TaskDefiner = require('../../task_definer');

/**
 * Expand the date-range of known messages for the given folder/label.
 */
return TaskDefiner.defineSimpleTask([
  {
    name: 'sync_grow',
    args: ['accountId', 'folderId'],

    exclusiveResources: [
      // Only one of us/sync_refresh is allowed to be active at a time.
      (args) => `sync:${args.accountId}`,
    ],

    priorityTags: [
      (args) => `view:fldr:${args.folderId}`
    ],

    run: function*(ctx, req) {
      // Get our current folder state.
      let folderSyncDb = ctx.account.folderSyncDbById.get(req.folderId);
      yield folderSyncDb.acquire(ctx.ctxId);



      // Find out new UIDs covering the range in question.
      let uids = yield ctx.pimap.search(
        req.folderId, searchSpec, { byUid: true });

      let messages = yield.ctx.pimap.listMessages(
        req.folderId,
        uids,
        [
          'UID',
          'INTERNALDATE',
          'X-GM-THRID',
          'X-GM-MSGID'
        ],
        { byUid: true }
      );

      let tasks = [];
      for (let msg of messages) {
        tasks.push({
          name: 'sync_conv',
        });
      }

      yield ctx.finishTask({

      })
    }
  }
]);
});

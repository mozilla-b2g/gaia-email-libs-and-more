define(function(require) {

var TaskDefiner = require('../../task_definer');

/**
 * Sync the folder list for a GMail account.  This has
 */
return TaskDefiner.defineSimpleTask([
  {
    name: 'sync_folder_list',
    args: ['accountId'],

    exclusiveResources: [
      // Nothing else that touches folder info is allowed in here.
      (args) => `folderInfo:${args.accountId}`,
    ],

    priorityTags: [
    ],

    // There is nothing for us to plan
    plan: null,

    execute: function*(ctx, req) {

      let boxesRoot = yield ctx.pimap.listBoxes();
      let namespaces = yield ctx.pimap.listNamespaces();


      yield ctx.finishTask({

      })
    }
  }
]);
});

define(function(require) {

let TaskDefiner = require('../../task_definer');

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
      let account = ctx.universe.acquireAccount(req.accountId);
      let imapAccount = account.imapAccount;

      let boxesRoot = yield account.pimap.listBoxes();
      let namespaces = yield account.pimap.listNamespaces();

      imapAccount.processFolderListUpdates(boxesRoot, namespaces);

      yield ctx.finishTask({
        mutations: {
          [account.id]: imapAccount.folderTOC.generatePersistenceInfo()
        }
      });
    }
  }
]);
});

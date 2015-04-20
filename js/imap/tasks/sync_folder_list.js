define(function(require) {
'use strict';

let co = require('co');
let logic = require('logic');
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

    execute: co.wrap(function*(ctx, planned) {
      logic(ctx, 'execute', { planned: planned });
      let account = yield ctx.universe.acquireAccount(ctx, planned.accountId);
      let imapAccount = account.imapAccount;

      let boxesRoot = yield account.pimap.listMailboxes();
      let namespaces = yield account.pimap.listNamespaces();

      imapAccount.processFolderListUpdates(boxesRoot, namespaces);

      yield ctx.finishTask({
        mutations: {
          folders: new Map([
            [account.id, imapAccount.foldersTOC.generatePersistenceInfo()]
          ]),
        },
        // all done!
        taskState: null
      });
    })
  }
]);
});

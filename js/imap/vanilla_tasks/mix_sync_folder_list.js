define(function(require) {
'use strict';

let co = require('co');

const { shallowClone } = require('../../util');

/**
 * Mix-in for folder list synchronization and ensuring that an account has all
 * the required offline and online folders.  Offline folders are handled during
 * the planning phase, online folders are handled during the online phase.
 *
 * The logic here isn't particularly complex, but how we handle folders has
 * planned changes, so it seems better to avoid duplicated code even if clarity
 * takes a hit for now.
 *
 * Consumers must provide:
 * - this.syncFolders(ctx, account)
 * - one of the following to handle offline folders:
 *   - this.ensureEssentialOfflineFolders(ctx, account) [preferred]
 *   - account.ensureEssentialOfflineFolders() [lazy legacy]
 *
 * In the case of POP3 where the server has no concept of folders, all folders
 * are offline folders and the planning stage is smart enough to realize it
 * should conclude the task after planning.
 */
return {
  name: 'sync_folder_list',
  args: ['accountId'],

  /**
   * Ensure offline folders.
   */
  plan: co.wrap(function*(ctx, rawTask) {
    let decoratedTask = shallowClone(rawTask);

    decoratedTask.exclusiveResources = [
      // Nothing else that touches folder info is allowed in here.
      `folderInfo:${rawTask.accountId}`,
    ];
    decoratedTask.priorityTags = [
      'view:folders'
    ];

    let account = yield ctx.universe.acquireAccount(ctx, rawTask.accountId);
    let mutations = {}, didMutateFolders;
    if (this.ensureEssentialOfflineFolders) {
      didMutateFolders =
        yield this.ensureEssentialOfflineFolders(ctx, account, mutations);
    } else {
      // TODO: normalize these to happen in-task too, ideally with reused logic.
      account.ensureEssentialOfflineFolders();
      didMutateFolders = true;
    }

    if (didMutateFolders) {
      mutations.folders = new Map([
        [account.id, account.foldersTOC.generatePersistenceInfo()]
      ]);
    }

    yield ctx.finishTask({
      mutations,
      // If we don't have an execute method, we're all done already. (POP3)
      taskState: this.execute ? decoratedTask : null
    });
  }),

  execute: co.wrap(function*(ctx, planned) {
    let account = yield ctx.universe.acquireAccount(ctx, planned.accountId);

    yield* this.syncFolders(ctx, account);

    // XXX migrate ensureEssentialOnlineFolders to be something the actual
    // instance provides and that we convert into a list of create_folder tasks.
    // (Which implies that mailuniverse should be using task_recipe helpers or
    // something like that?  We should probably ponder the more extreme folder
    // hierarchy situations we could enable like archive-by-month/etc. to help
    // drive the structure.)
    //
    // account.ensureEssentialOnlineFolders();


    yield ctx.finishTask({
      mutations: {
        folders: new Map([
          [account.id, account.foldersTOC.generatePersistenceInfo()]
        ]),
      },
      /*
      newData: {
        tasks: ...
      },
      */
      // all done!
      taskState: null
    });
  })
};
});

import logic from 'logic';

import { shallowClone } from 'shared/util';

import { prioritizeNewer } from '../../../date_priority_adjuster';


import TaskDefiner from '../../../task_infra/task_definer';

import churnConversation from '../../../churn_drivers/conv_churn_driver';
import { TransactionChewer } from '../chew_xact';
import { UserChewer } from '../chew_users';
import { PatchChewer } from '../chew_patch';


export default TaskDefiner.defineSimpleTask([
  {
    name: 'sync_drev',

    async plan(ctx, rawTask) {
      let plannedTask = shallowClone(rawTask);

      plannedTask.exclusiveResources = [
        `conv:${rawTask.convId}`
      ];

      plannedTask.priorityTags = [
        `view:conv:${rawTask.convId}`
      ];

      // Prioritize syncing the conversation by how new it is.
      if (rawTask.mostRecent) {
        plannedTask.relPriority = prioritizeNewer(rawTask.mostRecent);
      }

      await ctx.finishTask({
        taskState: plannedTask
      });
    },

    /**
     * Synchronize a revision which is believed to have changes or was
     * previously unknown.
     */
    async execute(ctx, req) {
      let account = await ctx.universe.acquireAccount(ctx, req.accountId);
      let foldersTOC =
        await ctx.universe.acquireAccountFoldersTOC(ctx, ctx.accountId);

      // ## Fetch the current revision details and its transactions in parallel.
      const revDetailsProm = account.client.apiCall(
        'differential.revision.search',
        {
          constraints: {
            phids: [req.drevPhid],
          },
          attachments: {
            reviewers: true,
            subscribers: true,
            projects: true,
            'reviewers-extra': true,
          }
        }
      );
      const revTransactionsProm = account.client.apiCall(
        'transaction.search',
        {
          objectIdentifier: req.drevPhid,
        }
      );

      const revDetails = await revDetailsProm;
      const revTransactions = await revTransactionsProm;

      // ## Begin Mutation
      // TODO: Improve the TransactionChewer so that it's able to run for the
      // UserChewer lookup side-effects prior to this point so we can do the
      // network lookups before entering the mutation phase.
      //
      // Right now the `oldMessages` avoid-doing-work-twice logic wants the DB
      // lookups to have already happened, but that's information that we could
      // load as a read-only read, possibly from a short digest/summary.  (The
      // info can't change outside this task, so there's no risk of divergence.)
      // Alternately, the TaskChewer could do the full work each time and just
      // reconcile as a second pass if we think pathologically large reviews
      // are going to be rare.
      let fromDb = await ctx.beginMutate({
        // It's explicitly possible the conversation doesn't exist yet, in that
        // case we'll get `undefined` back when we do the map lookup.  We do
        // need to be aware of this and make sure we use `newData` in that case.
        conversations: new Map([[req.convId, null]]),
        messagesByConversation: new Map([[req.convId, null]])
      });

      const revInfo = revDetails.data[0];

      const oldMessages = fromDb.messagesByConversation.get(req.convId);
      const oldConvInfo = fromDb.conversations.get(req.convId);

      let patchInfo;

      // ## If we don't have the current version of the patch, then fetch it.
      if (!oldConvInfo || !oldConvInfo.app ||
          !oldConvInfo.app.patchInfo ||
          oldConvInfo.app.patchInfo.diffPHID !== revInfo.fields.diffPHID) {
        const diffPHID = revInfo.fields.diffPHID;

        // The raw diff lookup needs the numeric id from the diffInfo based on
        // my preliminary investigations, so we need to do a diff search to get
        // that info from the diffPHID.
        const diffInfo = (await account.client.apiCall(
          'differential.diff.search',
          {
            constraints: {
              phids: [diffPHID]
            },
            attachments: {
              commits: true
            },
          }
        )).data[0];

        const rawDiff = await account.client.apiCall(
          'differential.getrawdiff',
          {
            diffID: diffInfo.id,
          }
        );

        const patchChewer = new PatchChewer();
        const { dirStats } = patchChewer.chewPatch(rawDiff);

        const virtFolderIds = [];
        const dirInfos = [];
        for (const [dirName, dirInfo] of dirStats.entries()) {
          const virtFolderInfo = foldersTOC.ensureLocalVirtualFolder(
            ctx, `patch-paths/${dirName}`);
          virtFolderIds.push(virtFolderInfo.id);
          dirInfos.push(dirInfo);
        }

        patchInfo = {
          diffPHID,
          virtFolderIds,
          dirInfos,
        };
      } else {
        patchInfo = oldConvInfo.app.patchInfo;
      }

      const userChewer = new UserChewer();
      const txChewer = new TransactionChewer({
        taskContext: ctx,
        userChewer,
        convId: req.convId,
        oldConvInfo,
        oldMessages,
        foldersTOC,
        revInfo,
      });

      for (const tx of revTransactions.data) {
        txChewer.chewTransaction(tx);
      }

      await userChewer.gatherDataFromServer(account.client);

      const convMeta = {
        drevInfo: {
          status: revInfo.fields.status.name,
        },
        patchInfo,
      };

      let convInfo = churnConversation(
        req.convId, oldConvInfo, txChewer.allMessages, 'phab-drev', convMeta);

      // ## Finish the task
      // Properly mark the conversation as new or modified based on whether we
      // had an old conversation.
      let modifiedConversations, newConversations;
      if (oldConvInfo) {
        modifiedConversations = new Map([[req.convId, convInfo]]);
      } else {
        newConversations = [convInfo];
      }

      await ctx.finishTask({
        mutations: {
          conversations: modifiedConversations,
          messages: txChewer.modifiedMessageMap
        },
        newData: {
          conversations: newConversations,
          messages: txChewer.newMessages
        }
      });
    },
  }
]);

import logic from 'logic';

import { shallowClone } from '../../../util';

import { prioritizeNewer } from '../../../date_priority_adjuster';


import TaskDefiner from '../../../task_infra/task_definer';
import a64 from '../../../a64';

import { conversationMessageComparator } from '../../../db/comparators';

import churnConversation from '../../../churn_drivers/conv_churn_driver';
import { TransactionChewer } from '../chew_xact';
import { UserChewer } from '../chew_users';


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

      const oldMessages = fromDb.messagesByConversation.get(req.convId);
      const oldConvInfo = fromDb.conversations.get(req.convId);

      // ## If we don't have the current version of the patch, then fetch it.
      // XXX Implement the patch stuff.

      const userChewer = new UserChewer();
      const txChewer = new TransactionChewer({
        userChewer,
        convId: req.convId,
        oldConvInfo,
        oldMessages,
        foldersTOC,
      });

      for (const tx of revTransactions.data) {
        txChewer.chewTransaction(tx);
      }

      await userChewer.gatherDataFromServer(account.client);


      let convInfo = churnConversation(req.convId, oldConvInfo, txChewer.allMessages);

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

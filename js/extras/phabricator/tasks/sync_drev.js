import logic from 'logic';

import { shallowClone } from '../../util';

import { prioritizeNewer } from '../../date_priority_adjuster';


import TaskDefiner from '../../task_infra/task_definer';
import a64 from '../../a64';

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
     * Shared code for processing new-to-us messages based on their UID.
     *
     * @param {TaskContext} ctx
     * @param account
     * @param {FolderMeta} allMailFolderInfo
     * @param {ConversationId} convId
     * @param {UID[]} uids
     * @param {SyncStateHelper} [syncState]
     *   For the new conversation case where we may be referencing messages that
     *   are not already known to the sync state and need to be enrolled.  In
     *   most cases these messages will be "meh", but it's also very possible
     *   that server state has changed since the sync_refresh/sync_grow task ran
     *   and that some of those messages will actually be "yay".
     */
    async _fetchAndChewUids(ctx, account, allMailFolderInfo, convId,
                            uids, syncState) {
      let messages = [];

      let rawConvId;
      if (syncState) {
        rawConvId = encodedGmailConvIdFromConvId(convId);
      }

      if (uids && uids.length) {
        let foldersTOC =
          await ctx.universe.acquireAccountFoldersTOC(ctx, account.id);
        let labelMapper = new GmailLabelMapper(ctx, foldersTOC);

        let { result: rawMessages } = await account.pimap.listMessages(
          ctx,
          allMailFolderInfo,
          uids,
          INITIAL_FETCH_PARAMS,
          { byUid: true }
        );

        for (let msg of rawMessages) {
          let rawGmailLabels = msg['x-gm-labels'];
          let flags = msg.flags || [];
          let uid = msg.uid;

          // If this is a new conversation, we need to track these messages
          if (syncState &&
              !syncState.yayUids.has(uid) &&
              !syncState.mehUids.has(uid)) {
            // (Sync state wants the label status as reflected by the server,
            // so we don't want store_labels to perform fixup for us.)
            let serverFolderIds =
              labelMapper.labelsToFolderIds(rawGmailLabels);
            let dateTS = parseImapDateTime(msg.internaldate);

            if (syncState.messageMeetsSyncCriteria(dateTS, serverFolderIds)) {
              syncState.newYayMessageInExistingConv(uid, rawConvId);
            } else {
              syncState.newMehMessageInExistingConv(uid, rawConvId);
            }
          }

          // Have store_labels apply any (offline) requests that have not yet
          // been replayed to the server.
          ctx.synchronouslyConsultOtherTask(
            { name: 'store_labels', accountId: account.id },
            { uid: msg.uid, value: rawGmailLabels });
          // same with store_flags
          ctx.synchronouslyConsultOtherTask(
            { name: 'store_flags', accountId: account.id },
            { uid: msg.uid, value: flags });

          let folderIds = labelMapper.labelsToFolderIds(rawGmailLabels);

          let messageInfo = chewMessageStructure(
            msg,
            null, // we don't pre-compute the headers.
            folderIds,
            flags,
            convId
          );
          messages.push(messageInfo);
        }
      }

      return messages;
    },

    /**
     * It's a new conversation so we:
     * - Search to find all the messages in the conversation
     * - Fetch their envelopes, creating HeaderInfo/BodyInfo structures
     * - Derive the ConversationInfo from the HeaderInfo instances
     */
    async _execNewConv(ctx, req) {
      let fromDb = await ctx.beginMutate({
        syncStates: new Map([[req.accountId, null]])
      });

      let syncState = new SyncStateHelper(
        ctx, fromDb.syncStates.get(req.accountId), req.accountId, 'conv');

      let account = await ctx.universe.acquireAccount(ctx, req.accountId);
      let allMailFolderInfo = account.getFirstFolderWithType('all');

      // Search for all the messages in the conversation
      let searchSpec = {
        'x-gm-thrid': convIdToGmailThreadId(req.convId)
      };
      let { result: uids } = await account.pimap.search(
        ctx, allMailFolderInfo, searchSpec, { byUid: true });
      logic(ctx, 'search found uids', { uids });

      let messages = await this._fetchAndChewUids(
        ctx, account, allMailFolderInfo, req.convId, uids, syncState);

      let convInfo = churnConversation(req.convId, null, messages);

      await ctx.finishTask({
        mutations: {
          syncStates: new Map([[req.accountId, syncState.rawSyncState]])
        },
        newData: {
          conversations: [convInfo],
          messages: messages
        }
      });
    },

    /**
     * Synchronize a revision which is believed to have changes or was
     * previously unknown.
     */
    async execute(ctx, req) {
      let account = await ctx.universe.acquireAccount(ctx, req.accountId);

      // ## Fetch the current revision details and its transactions in parallel.
      const revDetailsProm = account.apiCall(
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
      const revTransactionsProm = account.apiCall(
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

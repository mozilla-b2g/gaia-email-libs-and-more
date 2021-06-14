import logic from 'logic';

import { shallowClone } from 'shared/util';

import { prioritizeNewer } from '../../../date_priority_adjuster';


import TaskDefiner from '../../../task_infra/task_definer';

import { decodeUI64 as expandGmailConvId } from 'shared/a64';

import { encodedGmailConvIdFromConvId } from 'shared/id_conversions';

import { chewMessageStructure, parseImapDateTime } from '../imapchew';

import { conversationMessageComparator } from '../../../db/comparators';

import churnConversation from '../../../churn_drivers/conv_churn_driver';

import SyncStateHelper from '../gmail/sync_state_helper';
import GmailLabelMapper from '../gmail/gmail_label_mapper';


/**
 * Lose the account id prefix from a convId and convert the a64 rep into base 10
 */
function convIdToGmailThreadId(convId) {
  let a64Part = convId.substring(convId.indexOf('.') + 1);
  return expandGmailConvId(a64Part);
}


let INITIAL_FETCH_PARAMS = [
  'uid',
  'internaldate',
  'x-gm-msgid',
  'bodystructure',
  'flags',
  'x-gm-labels',
  'BODY.PEEK[' +
    'HEADER.FIELDS (FROM TO CC BCC SUBJECT REPLY-TO MESSAGE-ID REFERENCES)]'
];

/**
 * @typedef {Object} SyncConvTaskArgs
 * @prop accountId
 * @prop convId
 * @prop newConv
 * @prop removeConv
 * @prop newUids
 * @prop removedUids
 * @prop revisedUidState
 **/

/**
 * Fetches the envelopes for new messages in a conversation and also applies
 * flag/label changes discovered by sync_refresh (during planning).
 *
 * XXX??? do the planning stuff in separate tasks.  just have the churner handle
 * things.
 *
 * For a non-new conversation where we are told revisedUidState, in the planning
 * phase, apply the revised flags/labels.  (We handle this rather than
 * sync_refresh because this inherently necessitates a recomputation of the
 * conversation summary which quickly gets to be more work than sync_refresh
 * wants to do in its step.)
 *
 * For a non-new conversation where we are told removedUids, in the planning
 * phase, remove the messages from the database and recompute the conversation
 * summary.
 *
 * For a new conversation, in the execution phase, do a SEARCH to find all the
 * headers, FETCH all their envelopes, and add the headers/bodies to the
 * database.  This requires loading and mutating the syncState.  TODO: But we
 * want this to either avoid doing this or minimize what it gets up to.  One
 * possibility is to use a locking construct that allows multiple sync_conv
 * tasks such as ourselves to operate in parallel but block sync_refresh from
 * operating until all of us have completed.  This would allow us to do
 * scattered writes that the sync_conv would slurp up and integrate into the
 * sync state when it starts.  This would accomplish our goals of 1) letting us
 * being parallelized and 2) keeping sync_refresh smaller/simpler so it doesn't
 * need to do this too.
 *
 * For a non-new conversation where we are told newUids, in the execution
 * phase, FETCH their envelopes and add the headers/bodies to the database.
 * This does not require loading or mutating the syncState; sync_refresh already
 * updated itself.
 */
export default TaskDefiner.defineSimpleTask([
  {
    name: 'sync_conv',

    async plan(ctx, rawTask) {
      let plannedTask = shallowClone(rawTask);

      plannedTask.exclusiveResources = [
        `conv:${rawTask.convId}`
      ];
      // In the newConv case, we need to load the sync-state for the account
      // in order to add additional meh UIDs we learn about.  This is not
      // particularly desirable, but not trivial to avoid.
      if (rawTask.newConv) {
        plannedTask.exclusiveResources.push(`sync:${rawTask.accountId}`);
      }

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
     * The conversation is no longer relevant or no longer exists, delete all
     * traces of the conversation from our perspective.
     */
    async _execDeleteConv(ctx, req) {
      // Deleting a conversation requires us to first load it for mutation so
      // that we have pre-state to be able to remove it from the folder id's
      // it is associated with.
      await ctx.beginMutate({
        conversations: new Map([[req.convId, null]])
      });
      await ctx.finishTask({
        mutations: {
          conversations: new Map([[req.convId, null]])
        }
      });
    },

    /**
     * We learned about new UIDs in a conversation:
     * - Load the existing data about the conversation
     * - Apply any state changes to the already-known messages
     * - Fetch the envelopes for any new message
     * - Rederive/update the ConversationInfo given all the messages.
     */
    async _execModifyConv(ctx, req) {
      let account = await ctx.universe.acquireAccount(ctx, req.accountId);
      let allMailFolderInfo = account.getFirstFolderWithType('all');

      let fromDb = await ctx.beginMutate({
        conversations: new Map([[req.convId, null]]),
        messagesByConversation: new Map([[req.convId, null]])
      });

      let loadedMessages = fromDb.messagesByConversation.get(req.convId);
      let modifiedMessagesMap = new Map();

      let keptMessages = [];
      for (let message of loadedMessages) {
        if (req.removedUids && req.removedUids.has(message.id)) {
          // removed!
          modifiedMessagesMap.set(message.id, null);
        } else {
          // kept, possibly modified
          keptMessages.push(message);
          if (req.modifiedUids && req.modifiedUids.has(message.id)) {
            let newState = req.modifiedUids.get(message.id);

            message.flags = newState.flags;
            message.labels = newState.labels;

            modifiedMessagesMap.set(message.id, message);
          }
        }
      }

      // Fetch the envelopes from the server and create headers/bodies
      let newMessages = await this._fetchAndChewUids(
        ctx, account, allMailFolderInfo, req.convId,
        req.newUids && Array.from(req.newUids), false);

      // Ensure the messages are ordered correctly
      let allMessages = keptMessages.concat(newMessages);
      allMessages.sort(conversationMessageComparator);

      let oldConvInfo = fromDb.conversations.get(req.convId);
      let convInfo = churnConversation(req.convId, oldConvInfo, allMessages);

      await ctx.finishTask({
        mutations: {
          conversations: new Map([[req.convId, convInfo]]),
          messages: modifiedMessagesMap
        },
        newData: {
          messages: newMessages
        }
      });
    },

    execute(ctx, req) {
      // Dispatch based on what actually needs to be done.  While one might
      // think this is begging for 3 separate task types, unification can be
      // applied here and it wants to be conversation-centric in nature,
      // suggesting a single task type is the right call.
      if (req.newConv) {
        return this._execNewConv(ctx, req);
      } else if (req.delConv) {
        return this._execDeleteConv(ctx, req);
      } else {
        return this._execModifyConv(ctx, req);
      }
    }
  }
]);

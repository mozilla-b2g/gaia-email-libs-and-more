define(function(require) {
'use strict';

let logic = require('logic');
let co = require('co');
let { shallowClone } = require('../../util');
let { NOW } = require('../../date');

let TaskDefiner = require('../../task_definer');
let a64 = require('../../a64');
let expandGmailConvId = a64.decodeUI64;

let { encodedGmailConvIdFromConvId } = require('../../id_conversions');

let { chewMessageStructure } = require('../imapchew');

let { conversationMessageComparator } = require('../../db/comparators');

let churnConversation = require('../../churns/conv_churn');

let SyncStateHelper = require('../sync_state_helper');
let GmailLabelMapper = require('../gmail_label_mapper');


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

const MAX_PRIORITY_BOOST = 99999;
const ONE_HOUR_IN_MSECS = 60 * 60 * 1000;

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
 * database.  This requires loading and mutating the syncState.
 *
 * For a non-new conversation where we are told newUids, in the execution
 * phase, FETCH their envelopes and add the headers/bodies to the database.
 * This does not require loading or mutating the syncState; sync_refresh already
 * updated itself.
 */
return TaskDefiner.defineSimpleTask([
  {
    name: 'sync_conv',

    plan: co.wrap(function*(ctx, rawTask) {
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

      // If we know how recent the conversation is, use it to provide a priority
      // boost.  This is a question of quantization/binning and how much range
      // we have/need/care about.  Since we currently let relative priorities
      // go from -10k to +10k (exclusive), using hours in the past provides
      // useful differentiation for ~23 years which is sufficient for our needs.
      // Note that this relative priority is frozen in time at the instance of
      // planning
      if (rawTask.mostRecent) {
        plannedTask.relPriority = Math.max(
          -MAX_PRIORITY_BOOST,
          MAX_PRIORITY_BOOST -
            (NOW() - rawTask.mostRecent) / ONE_HOUR_IN_MSECS
        );
      }

      yield ctx.finishTask({
        taskState: plannedTask
      });
    }),

    _fetchAndChewUids: function*(ctx, account, allMailFolderInfo, convId,
                                 uids) {
      let messages = [];

      if (uids && uids.length) {
        let foldersTOC =
          yield ctx.universe.acquireAccountFoldersTOC(ctx, account.id);
        let labelMapper = new GmailLabelMapper(foldersTOC);

        let { result: rawMessages } = yield account.pimap.listMessages(
          allMailFolderInfo,
          uids,
          INITIAL_FETCH_PARAMS,
          { byUid: true }
        );

        for (let rawMessage of rawMessages) {
          let messageInfo = chewMessageStructure(
            rawMessage,
            labelMapper,
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
    _execNewConv: co.wrap(function*(ctx, req) {
      let fromDb = yield ctx.beginMutate({
        syncStates: new Map([[req.accountId, null]])
      });

      let syncState = new SyncStateHelper(
        ctx, fromDb.syncStates.get(req.accountId), req.accountId, 'conv');

      let account = yield ctx.universe.acquireAccount(ctx, req.accountId);
      let allMailFolderInfo = account.getFirstFolderWithType('all');

      // Search for all the messages in the conversation
      let searchSpec = {
        'x-gm-thrid': convIdToGmailThreadId(req.convId)
      };
      let { result: uids } = yield account.pimap.search(
        allMailFolderInfo, searchSpec, { byUid: true });
      logic(ctx, 'search found uids', { uids });

      // Any uids the sync state didn't already know about must be meh UIDs.
      // We need to track these so that sync_refresh knows we care about their
      // state changes and so that sync_grow doesn't get excited and think it
      // has discovered new messages if they are already known.
      let rawConvId = encodedGmailConvIdFromConvId(req.convId);
      for (let uid of uids) {
        if (!syncState.yayUids.has(uid) &&
            !syncState.mehUids.has(uid)) {
          syncState.newMehMessageInExistingConv(uid, rawConvId);
        }
      }

      let messages = yield* this._fetchAndChewUids(
        ctx, account, allMailFolderInfo, req.convId, uids);

      let convInfo = churnConversation(req.convId, null, messages);

      yield ctx.finishTask({
        mutations: {
          syncStates: new Map([[req.accountId, syncState.rawSyncState]])
        },
        newData: {
          conversations: [convInfo],
          messages: messages
        }
      });
    }),

    /**
     * The conversation is no longer relevant or no longer exists, delete all
     * traces of the conversation from our perspective.
     */
    _execDeleteConv: co.wrap(function*(ctx, req) {
      // Deleting a conversation requires us to first load it for mutation so
      // that we have pre-state to be able to remove it from the folder id's
      // it is associated with.
      yield ctx.beginMutate({
        conversations: new Map([[req.convId, null]])
      });
      yield ctx.finishTask({
        mutations: {
          conversations: new Map([[req.convId, null]])
        }
      });
    }),

    /**
     * We learned about new UIDs in a conversation:
     * - Load the existing data about the conversation
     * - Apply any state changes to the already-known messages
     * - Fetch the envelopes for any new message
     * - Rederive/update the ConversationInfo given all the messages.
     */
    _execModifyConv: co.wrap(function*(ctx, req) {
      let account = yield ctx.universe.acquireAccount(ctx, req.accountId);
      let allMailFolderInfo = account.getFirstFolderWithType('all');

      let fromDb = yield ctx.beginMutate({
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
      let newMessages = yield* this._fetchAndChewUids(
        ctx, account, allMailFolderInfo, req.convId,
        req.newUids && Array.from(req.newUids));

      // Ensure the messages are ordered correctly
      let allMessages = keptMessages.concat(newMessages);
      allMessages.sort(conversationMessageComparator);

      let oldConvInfo = fromDb.conversations.get(req.convId);
      let convInfo = churnConversation(req.convId, oldConvInfo, allMessages);

      yield ctx.finishTask({
        mutations: {
          conversations: new Map([[req.convId, convInfo]]),
          messages: modifiedMessagesMap
        },
        newData: {
          messages: newMessages
        }
      });
    }),

    execute: function(ctx, req) {
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

});

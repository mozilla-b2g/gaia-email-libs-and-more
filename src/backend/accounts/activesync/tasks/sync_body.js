import TaskDefiner from '../../../task_infra/task_definer';

import FolderSyncStateHelper from '../folder_sync_state_helper';

import churnConversation from '../../../churn_drivers/conv_churn_driver';

import { processMessageContent } from '../../../bodies/mailchew';

import downloadBody from '../smotocol/download_body';
import downloadBody25 from '../smotocol/download_body_25';

import { Enums as asbEnum } from 'activesync/codepages/AirSyncBase';


import { DESIRED_SNIPPET_LENGTH } from '../../../syncbase';

import MixinSyncBody from '../../../task_mixins/mix_sync_body';

/**
 * The desired number of bytes to fetch when downloading bodies, but the body's
 * size exceeds the maximum requested size.
 */
const DESIRED_TEXT_SNIPPET_BYTES = 512;

/**
 * A custom execute() implementation building on top of Vanilla IMAP's sync_body
 * plan() implementation and general implementation strategy.
 *
 * The primary differences we run into that make us deviate enough that this is
 * a good idea:
 * - For ActiveSync there's only ever one body part, at least as currently
 *   implemented.  There are some nightmares on the horizon.
 * - We have a different protocol request for 2.5 versus 12.0+ versions, and
 *   the flipping 2.5 version needs the syncKey which means it needs to access
 *   the FolderSyncState too.  It's not so bad that we need to mark 2.5 with
 *   a different engine, but it's certainly frustrating.
 */
export default TaskDefiner.defineComplexTask([
  MixinSyncBody,
  {
    async execute(ctx, persistentState, memoryState, marker) {
      let req = memoryState.get(marker.convId);

      // -- Acquire the account and establish a connection
      // We need the protcol version to know whether our mutation request needs
      // the folder sync state or not.
      let account = await ctx.universe.acquireAccount(ctx, marker.accountId);
      let conn = await account.ensureConnection();
      let use25 = conn.currentVersion.lt('12.0');

      // -- Retrieve the conversation and its messages for mutation
      let fromDb = await ctx.beginMutate({
        conversations: new Map([[req.convId, null]]),
        messagesByConversation: new Map([[req.convId, null]])
      });

      let oldConvInfo = fromDb.conversations.get(req.convId);
      let loadedMessages = fromDb.messagesByConversation.get(req.convId);
      let modifiedMessagesMap = new Map();

      // -- Get the message locations
      let umidLocations = new Map();
      for (let message of loadedMessages) {
        umidLocations.set(message.umid, null);
      }

      // We need to look up all the umidLocations.
      await ctx.read({
        umidLocations
      });

      // -- Get the folder sync states
      // XXX this is all 2.5 stuff, we can avoid it for 12.0+ but until we have
      // unit tests, it's safest to leave this code active so it's clear it's
      // not broken.  This just ends up as a wasteful no-op.
      let rawSyncStateReads = new Map();
      for (let [folderId] of umidLocations.values()) {
        rawSyncStateReads.set(folderId, null);
      }
      await ctx.mutateMore({
        syncStates: rawSyncStateReads
      });

      let syncStates = new Map();
      for (let [folderId, rawSyncState] of rawSyncStateReads) {
        syncStates.set(
          folderId,
          new FolderSyncStateHelper(ctx, rawSyncState, marker.accountId,
                                    folderId));
      }

      // Determine our byte budget for each message.  If omitted, we fetch the
      // whole thing.
      let truncationSize = 0;
      if (req.amount === 'snippet') {
        truncationSize = DESIRED_SNIPPET_LENGTH;
      } else if (req.amount) {
        truncationSize = req.amount;
      }

      // -- For each message...
      for (let message of loadedMessages) {
        let [folderId, messageServerId] = umidLocations.get(message.umid);
        let folderInfo = account.getFolderById(folderId);
        let folderServerId = folderInfo.serverId;
        let syncState = syncStates.get(folderId);

        // ActiveSync only stores one body rep, no matter how many body parts
        // the MIME message actually has.
        let bodyRep = message.bodyReps[0];
        let bodyType = bodyRep.type;

        // If we're truncating (and therefore this is a snippet request), and
        // the truncating will actually work, then switch over to plaintext
        // mode and just get enough for a snippet.
        // TODO: normalize/improve this in the context of the above.  I'm doing
        // this for consistency with pre-convoy, but since this refactor is
        // straightening out the control flow, this might not be needed.
        let snippetOnly = false;
        if (truncationSize &&
            truncationSize < bodyRep.sizeEstimate) {
          snippetOnly = true;
          if (!use25) {
            bodyType = 'plain';
            truncationSize = DESIRED_TEXT_SNIPPET_BYTES;
          }
        }
        let asBodyType = bodyType === 'html' ? asbEnum.Type.HTML
                                             : asbEnum.Type.PlainText;

        // - Issue the fetch
        let bodyContent;
        if (use25) {
          // the destructuring assignment expression into existing variables
          // really annoys jshint (known bug), so I'm doing things manually for
          // now.
          let result = await downloadBody25(
            conn,
            {
              folderSyncKey: syncState.syncKey,
              folderServerId,
              messageServerId,
              bodyType: asBodyType
            });
          bodyContent = result.bodyContent;
          syncState.syncKey = result.syncKey;
        } else {
          bodyContent = (await downloadBody(
            conn,
            {
              folderServerId,
              messageServerId,
              bodyType: asBodyType,
              truncationSize
            })).bodyContent;
        }

        // - Update the message
        // We neither need to store or want to deal with \r in the processing of
        // the body. XXX this changes with mcav's streaming fixes.
        bodyContent = bodyContent.replace(/\r/g, '');

        let { contentBlob, snippet } = processMessageContent(
          bodyContent,
          bodyType,
          !snippetOnly, // isDownloaded
          true // generateSnippet
        );

        message.snippet = snippet;
        if (!snippetOnly) {
          bodyRep.contentBlob = contentBlob;
          bodyRep.isDownloaded = true;
        }

        modifiedMessagesMap.set(message.id, message);
      }

      // -- Update the conversation
      let convInfo = churnConversation(req.convId, oldConvInfo, loadedMessages);

      // since we're successful at this point, clear it out of the memory state.
      // TODO: parallelizing: see notes in mix_sync_body's execute or just
      // steal its implementation if the todo is gone.
      memoryState.delete(req.convId);

      await ctx.finishTask({
        mutations: {
          conversations: new Map([[req.convId, convInfo]]),
          messages: modifiedMessagesMap,
          // We don't actually want new sync states created if they don't
          // exist, so just giving back what we've mutated in-place is fine, if
          // bad hygiene.
          syncStates: rawSyncStateReads
        },
      });
    }
  }
]);

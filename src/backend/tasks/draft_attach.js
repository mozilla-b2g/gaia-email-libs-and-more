import { BLOB_BASE64_BATCH_CONVERT_SIZE } from '../syncbase';

import TaskDefiner from '../task_infra/task_definer';
import churnConversation from '../churn_drivers/conv_churn_driver';

import { makeAttachmentPart } from '../db/mail_rep';
import { mimeStyleBase64Encode } from 'safe-base64';

import { convIdFromMessageId } from 'shared/id_conversions';

/**
 * Per-account task to incrementally convert an attachment into its base64
 * encoded attachment form which we save in chunks to IndexedDB to avoid using
 * too much memory now or during the sending process.
 *
 * - Retrieve the body the draft is persisted to,
 * - Repeat until the attachment is fully attached:
 *   - take a chunk of the source attachment
 *   - base64 encode it into a Blob by creating a Uint8Array and manually
 *     encoding into that.  (We need to put a \r\n after every 76 bytes, and
 *     doing that using window.btoa is going to create a lot of garbage. And
 *     addressing that is no longer premature optimization.)
 *   - update the message with that Blob
 *   - write the updated message
 *   - force the message to be discarded from the cache and re-fetched.
 *     We won't be saving any memory until the Blob has been written to
 *     disk and we have forgotten all references to the in-memory Blob we wrote
 *     to the database.  (The Blob does not magically get turned into a
 *     reference to the database yet.  That's bug
 *     https://bugzilla.mozilla.org/show_bug.cgi?id=1192115)
 * - Be done.  Note that we leave the "small" Blobs independent; we do not
 *   create a super Blob.
 *
 * Eventually this task will likely be mooted by us just storing the Blobs we
 * want to send fully intact and performing encoding on-demand on the way out.
 *
 * Implementation note:
 */
export default TaskDefiner.defineSimpleTask([
  {
    name: 'draft_attach',

    async plan(ctx, req) {
      let { messageId } = req;
      let convId = convIdFromMessageId(messageId);
      let fromDb = await ctx.beginMutate({
        conversations: new Map([[convId, null]]),
        messagesByConversation: new Map([[convId, null]])
      });

      let messages = fromDb.messagesByConversation.get(convId);
      let modifiedMessagesMap = new Map();

      let messageInfo = messages.find(msg => msg.id === messageId);
      if (messageInfo === null) {
        throw new Error('moot');
      }
      let messageKey = [messageInfo.id, messageInfo.date];

      // -- Prep message rep
      const attachmentDef = req.attachmentDef;
      const wholeBlob = attachmentDef.blob;
      messageInfo.attaching = makeAttachmentPart({
        relId: attachmentDef.relId,
        name: attachmentDef.name,
        type: wholeBlob.type,
        sizeEstimate: wholeBlob.size,
        // Tell everyone this is a encoded draft attachment and not appropriate
        // for anyone to try and use other than draft logic.
        downloadState: 'draft',
        // this is where we put the Blob segments...
        file: [],
      });
      // -- Encode loop.
      let blobOffset = 0;
      while (blobOffset < wholeBlob.size) {
        let nextOffset =
          Math.min(wholeBlob.size,
                   blobOffset + BLOB_BASE64_BATCH_CONVERT_SIZE);
        console.log('attachBlobToDraft: fetching', blobOffset, 'to',
                    nextOffset, 'of', wholeBlob.size);

        let slicedBlob = wholeBlob.slice(blobOffset, nextOffset);
        blobOffset = nextOffset;

        let arraybuffer = await slicedBlob.arrayBuffer();
        let binaryDataU8 = new Uint8Array(arraybuffer);
        let encodedU8 = mimeStyleBase64Encode(binaryDataU8);
        messageInfo.attaching.file.push(new Blob([encodedU8],
                                                 { type: wholeBlob.type }));
        // (in the v1.x job-op we'd do the finalization and transition from
        // attaching to attachments in this final pass here, but since we need
        // to issue an additional write anyways, we do that outside the loop.)

        // - Issue the incremental write
        await ctx.dangerousIncrementalWrite({
          messages: new Map([[messageId, messageInfo]])
        });

        // - Read back the Blob for memory usage reasons.
        let flushedReads = await ctx.mutateMore({
          flushedMessageReads: true,
          messages: new Map([[messageKey, null]])
        });

        messageInfo = flushedReads.messages.get(messageId);
      }

      // -- Finalize the attachment
      messageInfo.hasAttachments = true;
      messageInfo.attachments.push(messageInfo.attaching);
      delete messageInfo.attaching; // bad news for shapes, but drafts are rare.

      modifiedMessagesMap.set(messageId, messageInfo);

      // -- Churn the conversation
      let oldConvInfo = fromDb.conversations.get(req.convId);
      let convInfo = churnConversation(convId, oldConvInfo, messages);

      // -- Victory!
      await ctx.finishTask({
        mutations: {
          conversations: new Map([[convId, convInfo]]),
          messages: modifiedMessagesMap
        }
      });
    },

    execute: null
  }
]);

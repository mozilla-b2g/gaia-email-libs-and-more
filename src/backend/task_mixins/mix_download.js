import logic from 'logic';

import { convIdFromMessageId } from 'shared/id_conversions';
import { pickPartFromMessageByRelId } from '../db/mail_rep';

import { NOW } from 'shared/date';

import churnConversation from '../churn_drivers/conv_churn_driver';

// (DeviceStorage is not available here on the worker so we need to remote.)
import * as router from '../worker-router';
const sendStorageMessage = router.registerCallbackType('devicestorage');

import { DEVICE_STORAGE_NAME } from '../syncbase';

/**
 * Save a file to DeviceStorage, retrying with a different name if it seems like
 * we're experencing a name collision.  We do this here rather than in
 * devicestorage-main because we will still want this logic even when we can
 * directly access DeviceStorage from here in the worker.
 */
async function uniqueifyingSaveHelper(ctx, blob, filename) {
  /* always register with the download manager */
  const register = true;

  let result = await sendStorageMessage(
    'save', [DEVICE_STORAGE_NAME, blob, filename, register]);

  let [initialSucesss] = result;
  if (initialSucesss) {
    return result;
  }

  // Retry by appending a super huge timestamp to the file before its
  // extension.
  let idxLastPeriod = filename.lastIndexOf('.');
  if (idxLastPeriod === -1) {
    idxLastPeriod = filename.length;
  }
  const retryFilename =
    filename.substring(0, idxLastPeriod) + '-' + NOW() +
    filename.substring(idxLastPeriod);

  result = await sendStorageMessage(
    'save', [DEVICE_STORAGE_NAME, blob, retryFilename, register]);

  return result;
}

/**
 * The heart of the attachment/related-part download task, with each engine
 * providing their own download protocol stuff.  Note that POP3 does not do
 * downloading as such since it only does snippet-fetch or
 * entire-message-download (because POP3 is dumb).
 *
 * # Design #
 *
 * ## Use Cases ##
 *
 * We are used for downloading:
 * 1) Explicit file attachments.  These are expected to be potentially large,
 *    although the effective standardization of the ~25 meg email limit by many
 *    providers does potentially upper-bound things at 25 megabytes.
 * 2) multipart/related images.  Because of styling limits and the limits of the
 *    cid protocol, if present, there could potentially be a number of these and
 *    with a propensity to be small.
 *
 * # Implementation #
 *
 * ## Task Granularity, Multiple Downloads But Only One Overlay ##
 *
 * Attachments are not first-class.  We assign them their own id's for sanity,
 * but they live on the message that owns them and their life-cycles are bounded
 * by the message's lifetime, etc.
 *
 * For reasons of locality for us and for the server (especially for
 * multipart/related HTML with embedded images), we cluster all download
 * requests by their message.  This, unsurprisingly, is important for overlay
 * purposes too, since only messages can report overlays (unless we fancy things
 * up.)
 *
 * ## State and Persistence ##
 *
 * Our persistent task state tracks messages with pending downloads by id.  And
 * for each of these messages we store:
 * - messageDate: for random access fetching of the message without fetching the
 *   rest of the conversation.
 * - partDownloads: A Map from part relId to an object with the following keys:
 *   - target: A string that is either 'cache' (store in IndexedDB) or 'save'
 *     (save to DeviceStorage at /mnt/sdcard).
 *   - blobs: An array of Blobs storing the DL progress thus far.  We currently
 *     don't support resuming, the Blob storage here is just so we can launder
 *     the Blobs from memory-back to disk-backed.  (We don't do this on the
 *     MessageInfo because sending references to the memory-backed Blobs to the
 *     front-end that we don't want anyone holding onto is not helpful.)
 *
 * Each of the per-message records is stored as a separate IndexedDB key/value
 * using our task storage support for this.  We use full write-locking on these
 * records because execute() needs to perform blob laundering with write/read
 * cycles and we want plan to be able to execute concurrently.  This avoids data
 * loss combined with execute logic that, upon completion, acquires the lock
 * and only removes parts that are fully downloaded and only removes the entire
 * record if all parts have been downloaded.
 *
 * Our `plan` implementation ignores any redundant requests so that the
 * persistentState always represents work that actually needs to be done.
 * `execute` never needs to second-guess the state.
 *
 * Our in-memory per-message state currently is a Set of the relId's currently
 * being downloaded.
 *
 * ## Download Chunking/Streaming ##
 *
 * Long term, it's our dream to use WHATWG streams with backpressure correctly
 * propagated to the transport to avoid memory bloating in our processes.  But
 * we don't have that yet and we're not holding our breath.  However, we are
 * able to avoid worse-case scenarios.  Here's what we do:
 *
 * - ActiveSync: We use XHR with moz-chunked-arraybuffer to get and process
 *   data as it streams in, albeit without any ability (that we know of) for
 *   backpressure to be conveyed.
 * - IMAP: We issue chunked requests that are pulled by the stream as needed
 *   in order to approximate flow control.
 *
 * We use explicitly spawned sub-tasks to deal with the write-locking of our
 * complex task record.
 *
 * ## Overlays / Progress Tracking ##
 *
 * We provide our overlay as a Map from attachment relId to a dictionary of
 * properties:
 * - status: pending/active:
 *   - pending: We're planning on downloading it, but we're not there yet.
 *   - active: We are getting the bytes right now!  Note that this just means
 *     we've issued a batch request including this attachment, it could
 *     actually take some time before we start getting bytes.
 * - bytesDownloaded: The number of bytes we've downloaded so far.  This is
 *   currently based on chunking and so is not particularly granular.
 *
 * ## Mix-In Contract ##
 *
 * Must provide one of the following:
 * - downloadParts(ctx, account, messageInfo, parts): Given the list of parts
 *   to download, it is responsible for driving the downloads and returning a
 *   Promise that resolves to a stream that produces objects of the form
 *   { relId, blobCount, blob, done }.  In no case should the function
 *   manipulate the partInfo objects directly.
 *
 *   These properties are defined as:
 *   - relId: The relId assigned to the part.  This tells us what part we're
 *     getting an update about.
 *   - done: If true, indicates that we have already received all the blobs we
 *     are doing to receive for the given `relId`.  In this case, the blob will
 *     be null.  We are unable to provide `done` concurrently with the last Blob
 *     because of how the underlying streams are implemented.
 *   - blobCount: You can think of this as the blobIndex when `!done`, and the
 *     number of blobs you were previously told about when `done`.
 *   - blob: The actual (memory-backed) Blob consisting of the downloaded bytes.
 *     If we received any prior Blob parts (and put them in a list), then we'll
 *     concatenate them.
 *
 * May override:
 */
export default {
  name: 'download',

  // See the block comment above.
  initPersistentState() {
    return new Map();
  },

  _makeMarkerForMessage(accountId, messageId) {
    return {
      type: this.name,
      id: 'download:' + messageId,
      accountId,
      messageId
    };
  },

  deriveMemoryStateFromPersistentState(persistentState, accountId) {
    let markers = [];
    for (let messageId of persistentState.keys()) {
      markers.push(this._makeMarkerForMessage(accountId, messageId));
    }

    return {
      memoryState: {
        activeDownloadsByMessageId: new Map()
      },
      markers
    };
  },

  overlay_messages(persistentState, memoryState, messageId) {
    let pending = persistentState.get(messageId);
    // If nothing is pending, nothing can be active either.  Nothing to say.
    if (!pending) {
      return null;
    }
    let active = memoryState.activeDownloadsByMessageId.get(messageId);
    let overlay = new Map();
    for (let [relId, { blobs }] of pending.partDownloads.entries()) {
      let isActive = active && active.has(relId);
      let bytesDownloaded =
        blobs ? blobs.reduce((sum, blob) => sum + blob.size, 0) : 0;
      if (!isActive) {
        overlay.set(
          relId,
          {
            status: 'pending',
            bytesDownloaded
          });
      } else {
        overlay.set(
          relId,
          {
            status: 'active',
            bytesDownloaded
          });
      }
    }
    return overlay;
  },

  async plan(ctx, persistentState, memoryState, rawTask) {
    const { messageId, messageDate, parts: requestedParts } = rawTask;
    const groupPromise = ctx.trackMeInTaskGroup('download:' + messageId);

    // NB: We could arguably just depend on the persistentState here and just
    // acquire the write-lock without the read.
    const messageTaskKey = [ctx.accountId, this.name, messageId];
    let messageReq =
      await ctx.mutateSingle('complexTaskStates', messageTaskKey);
    if (!messageReq) {
      messageReq = {
        messageDate,
        partDownloads: new Map()
      };
    }
    let newlyRequestedCount = 0;

    const messageInfo =
      await ctx.readSingle('messages', [messageId, messageDate], messageId);

    for (let [relId, target] of requestedParts.entries()) {
      // Ignore if already tracked.
      if (relId in messageReq.partDownloads) {
        continue;
      }

      const part = pickPartFromMessageByRelId(messageInfo, relId);
      // If non-null, the part has already been downloaded somewhere and we
      // don't need to do anything.
      if (part.downloadState === null) {
        newlyRequestedCount++;
        messageReq.partDownloads.set(
          relId,
          {
            target,
            blobs: null
          });
      }
    }

    if (!newlyRequestedCount) {
      // nothing new requested means no changes and therefore no writes.
      await ctx.finishTask({});
    } else {
      // Be sure to track it in our persistent state too.  (We have the write
      // lock so we are allowed to set it.)
      persistentState.set(messageId, messageReq);
      const marker = this._makeMarkerForMessage(ctx.accountId, messageId);
      await ctx.finishTask({
        mutations: {
          complexTaskStates: new Map([[messageTaskKey, messageReq]]),
        },
        taskMarkers: new Map([[marker.id, marker]])
      });
    }

    return ctx.returnValue(groupPromise);
  },

  /**
   * We do this:
   * - Build the parts to-do list.
   * - Invoke the mixee-provided downloadParts method which returns a stream.
   * - Read the stream for Blob chunks of parts, laundering the blobs using our
   *   complex task state record.  We spawn a sub-task that acquires a
   *   write-lock for our task state each time.
   * - When we get a 'done' for a part, we do an ugly 2-step:
   *   - If there were multiple chunks, then we acquire a write-lock on the task
   *     record again, creating a single super-Blob made up of all the little
   *     Blobs.  This will create a mini I/O storm and causes our peak usage to
   *     be double what would otherwise be required, but it avoids a potential
   *     series of worse-case scenario nightmares should parts of Gecko really
   *     want to be dealing with a single file.  This can go away when we can
   *     actuall append to Files using FileHandle as we download.
   *   - Once we only have a single Blob/File, we acquire a write-lock on the
   *     task record and on the message itself.  We transfer the Blob over to
   *     the message and remove the part from the list of pending donwloads in
   *     the task record.
   * - (We keep doing that until the stream is done.)
   * - We re-acquire the task record write-lock.  If there is still something to
   *   do because another plan() ran, we re-issue our marker.  Otherwise we
   *   delete the task record.  (Yes, we could potentially have been clever and
   *   done this in a done part.  As noted in the plan case, we can potentially
   *   optimize this somewhat by just acquiring a write-lock without a read.)
   */
  async execute(ctx, persistentState, memoryState, marker) {
    const account = await ctx.universe.acquireAccount(ctx, marker.accountId);
    const { messageId } = marker;
    const { messageDate } = persistentState.get(messageId);

    let activeRelIds = new Set();
    memoryState.activeDownloadsByMessageId.set(messageId, activeRelIds);

    // --- Build the batch request.
    // Get a copy of the message info for read-only purposes so we have the
    // per-part AttachmentInfo to provide with the request.  (The parts will
    // not disappear unless this is a draft, and we don't service drafts.)
    let messageInfo = await ctx.readSingle(
      'messages', [messageId, messageDate], messageId);

    // (it's safe to latch the parts/messageInfo for the duration of the task
    // because they will only ever contain disk-backed Blobs.)
    let parts = [];
    // Use a block to let messageReq go out of scope once we're done with it to
    // avoid later confusion with the copies our subtask loads from disk.
    {
      // (plan() only adds things to the messageReq, so a stale result doesn't
      // matter to us.)
      let messageReq = persistentState.get(messageId);
      for (let relId of messageReq.partDownloads.keys()) {
        activeRelIds.add(relId);
        parts.push(pickPartFromMessageByRelId(messageInfo, relId));
      }
    }

    // --- Issue the batch request
    const chunkedPartStream =
      await this.downloadParts(ctx, account, messageInfo, parts);
    const chunkedPartReader = chunkedPartStream.getReader();

    messageInfo = null;
    parts = null;

    // -- Consume the stream of part chunks.
    const messageTaskKey = [ctx.accountId, this.name, messageId];
    for(;;) {
      let { value, done: streamDone } = await chunkedPartReader.read();
      if (streamDone) {
        break;
      }

      let { relId, blobCount, blob, done } = value;
      if (!done) {
        // - Not done, do the append dance.
        await ctx.spawnSimpleMutationSubtask(
          { namespace: 'complexTaskStates', id: messageTaskKey },
          (messageReq) => {
            // If this is the first blob for the download, clobber-initialize so
            // that we clear out any partially completed downloads.  (We're not
            // clever enough yet to resume.)
            const partReq = messageReq.partDownloads.get(relId);
            if (blobCount === 0) {
              partReq.blobs = [];
            }
            partReq.blobs.push(blob);
            // Write-back our mutated object, and also update our
            // persistentState to reflect this.  This is okay because we have
            // the write-lock inside this function.
            persistentState.set(messageId, messageReq);
            return messageReq;
          }
        );
      } else {
        // - Yes, done.  Consolidate into super-blob if needed.
        // We only need to consolidate if there was more than one blob.
        if (blobCount > 1) {
          await ctx.spawnSimpleMutationSubtask(
            { namespace: 'complexTaskStates', id: messageTaskKey },
            (messageReq) => {
              const partReq = messageReq.partDownloads.get(relId);
              // NB: We consolidate into a single element array for consistency
              // with the single-element case.
              const multiBlobs = partReq.blobs;
              const singleBlob =
                new Blob(multiBlobs, { type: multiBlobs[0].type });
              partReq.blobs = [singleBlob];
              persistentState.set(messageId, messageReq);
              return messageReq;
            }
          );
        }

        // - Move the single Blob into the MessageInfo and update our messageReq
        // This needs to be a full-blown subtask since we need to acquire two
        // things: the MessageInfo and our fully-laundered messageReq.
        await ctx.spawnSubtask(async (subctx) => {
          const fromDb = await subctx.beginMutate({
            messages: new Map([[[messageId, messageDate], null]]),
            complexTaskStates: new Map([[messageTaskKey, null]])
          });
          const messageReq = fromDb.complexTaskStates.get(messageTaskKey);
          const partReq = messageReq.partDownloads.get(relId);
          const singleBlob = partReq.blobs[0];

          const mutateMessageInfo = fromDb.messages.get(messageId);

          // Update the part's state to be a cached download.
          const part = pickPartFromMessageByRelId(mutateMessageInfo, relId);
          if (partReq.target === 'cache') {
            part.downloadState = 'cached';
            part.file = singleBlob;
          } else { // must be 'save'
            // NB: We could have avoided the single blob consolidation above
            // (if it occurred in this target case), but massively erring on the
            // side of simpler control flow for now.
            // Use our save helper to avoid name collisions.
            let [saveSuccess, saveError, savedFilename, registered] =
              await uniqueifyingSaveHelper(ctx, singleBlob, part.name);
            if (saveSuccess) {
              part.downloadState = 'saved';
              part.file = [DEVICE_STORAGE_NAME, savedFilename];
              console.log(
                'saved attachment to', savedFilename, 'type:', singleBlob.type,
                'registered:', registered);
              logic(
                ctx, 'savedAttachment',
                {
                  savedFilename,
                  type: singleBlob.type,
                  size: singleBlob.size
                });
            } else {
              // A save failure sucks, but there's not much we can do at this
              // time other than complete the request without saving.  The only
              // user actionable possibility is a "disk full" scenario, and
              // that's something that's already up to the system to handle.
              // TODO: Explicit UX consideration of "disk full" from an email
              // perspective.
              console.warn(
                'failed to save attachment to', part.name, 'type:',
                singleBlob.type);
              logic(
                ctx,
                'saveFailure',
                {
                  type: singleBlob.type,
                  size: singleBlob.size,
                  saveError,
                  filename: savedFilename
                });
            }
          }

          // Update our request to have finished downloading the given relId.
          messageReq.partDownloads.delete(relId);
          persistentState.set(messageId, messageReq);

          // Write them out and be done.  Note that we do not update/re-churn
          // the conversation until the very end of the execute().
          await subctx.finishTask({
            mutations: {
              complexTaskStates: new Map([[messageTaskKey, messageReq]]),
              messages: new Map([[messageId, mutateMessageInfo]])
            }
          });
        });
      }
    }

    // -- All downloads completed!
    const convId = convIdFromMessageId(messageId);
    const fromDb = await ctx.beginMutate({
      conversations: new Map([[convId, null]]),
      messagesByConversation: new Map([[convId, null]]),
      complexTaskStates: new Map([[messageTaskKey, null]])
    });

    // - Churn the conversation
    // Note that even though we don't modify the messages at all, we needed
    // write-locks on them.
    const loadedMessages = fromDb.messagesByConversation.get(convId);
    const oldConvInfo = fromDb.conversations.get(convId);
    const convInfo = churnConversation(convId, oldConvInfo, loadedMessages);

    const messageReq = fromDb.complexTaskStates.get(messageTaskKey);
    let modifyComplexTaskStates;
    let modifyTaskMarkers;
    if (messageReq.partDownloads.size) {
      // We still have more to do because another plan() must have happened.
      // Reschedule our existing marker.
      modifyTaskMarkers = new Map([[marker.id, marker]]);
      // (and leave the task state as-is.)
    } else {
      // We have nothing more to do, we can delete the request.
      modifyTaskMarkers = new Map([[messageId, null]]);
      persistentState.delete(messageId);
    }

    // - Finish out the task/marker or re-enqueue as appropriate
    await ctx.finishTask({
      mutations: {
        conversations: new Map([[convId, convInfo]]),
        complexTaskStates: modifyComplexTaskStates
      },
      taskMarkers: modifyTaskMarkers
    });
  },
};

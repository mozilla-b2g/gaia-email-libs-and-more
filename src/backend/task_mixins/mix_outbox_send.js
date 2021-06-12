/* eslint-disable no-fallthrough */
import churnConversation from '../churn_drivers/conv_churn_driver';

import { Composer }from '../drafts/composer';

import { convIdFromMessageId } from 'shared/id_conversions';

/**
 * Outbox sending logic.  It's a mix-in because how we handle the sent folder is
 * account specific.  (In v1.x we had a hacky helper method on the accounts that
 * might generate a job-op as a side effect that doesn't fit into our better,
 * faster, stronger task implementation.)
 *
 * Whether to send a message is tracked explicitly as part of our complex state
 * rather than having there be something inherently magical about a
 * draft/message being in the outbox.  A draft is moved to the outbox by us and
 * out of the outbox by us.  We own the outbox.  But if some other code goes
 * rogue and puts a message in the outbox, nothing happens.
 *
 * We do this because:
 * - It's conceptually simpler and there are fewer moving parts by keeping
 *   everything in here.
 * - This aligns better with the overlay mechanism and having (potentially
 *   detailed) send-status information relayed granularly.  However, note that
 *   non-transient send failure information is tracked on the message as part of
 *   the draftInfo because if there's something structurally wrong with a
 *   message and we're not going to retry, that message is no longer tracked by
 *   us.
 *
 * Users of this mix-in MUST provide implementations for:
 * - shouldIncludeBcc: This tells us whether the composer should include the bcc
 *   headers in the built-body we will pass to sendMessage.  This only matters
 *   because at one point in time there were SMTP servers that would pass the
 *   bcc header through intact.  For safety/paranoia, one would want this to be
 *   false unless the sending server is also responsible for saving the message
 *   into a server-side sent folder.
 *
 * Users of this mix-in may opt to provide implementations for:
 * - sendMessage: The actual sending step, which should return a promise.  By
 *   default, the traditional account.sendMessage(composer) is invoked.  This
 *   exists as a migration path so that we don't have to hang the method off the
 *   account and can instead move things into their own distinct files' as we've
 *   done for ActiveSync and its "smotocol" subdirectory.
 * - saveSentMessage: Do whatever's required with the MessageInfo and/or list
 *   and follow-on processing tasks required.  See the call-site for more
 *   information.
 */
export default {
  name: 'outbox_send',

  /**
   * @return {}
   */
  initPersistentState() {
    return {
      /**
       * The messages to send, with their id as the key and their current date
       * and send order stored as the value object.  Specifically, { date,
       * order }.  The order is negated to be made into the relPriority so
       * that messages queued for sending earlier will have a higher priority.
       */
      messageIdsToSend: new Map(),
      /**
       * In order to provide FIFO send semantics, we need to keep a counter
       * so we can provide relative priority boosts while remaining in the
       * (-100k, +100k) adjustment range we have.  It's tricky and unnecessary
       * to map the message dates into this space in a stable way, which is
       * why we do this.
       *
       * This value gets reset to zero whenever messageIdsToSend becomes
       * empty because we don't need/want this to be usable as a counter for
       * how many messages have been sent from this account.
       */
       sendOrderingCounter: 0,
    };
  },

  _markerIdForMessage(accountId, messageId) {
    return this.name + ':' + messageId;
  },

  _makeMarkerForMessage(accountId, messageId, order) {
    return {
      type: this.name,
      id: this._markerIdForMessage(accountId, messageId),
      accountId,
      onlineOnly: true,
      priorityTags: [],
      // TODO: make us depend on the account's online resource
      resources: [],
      exclusiveResources: [],
      relPriority: -order,
      messageId
    };
  },

  /**
   * At startup, assume we want to send all messages.
   */
  deriveMemoryStateFromPersistentState(persistentState, accountId) {
    let markers = [];
    for (let [messageId, { order }] of
         persistentState.messageIdsToSend) {
      markers.push(
        this._makeMarkerForMessage(accountId, messageId, order));
    }

    return {
      memoryState: {
        /**
         * Are we currently paused?  This is a memory-only thing.  We don't
         * persist this since the functionality is only to accomodate the UX
         * flow of a user trying to abort a message.
         */
        paused: false,
        /**
         * Sends that are currently in-flight.  These will also still be
         * tracked in our persistent state until they complete.  This exists
         * to indicate the set of messages that can no longer be aborted and
         * to provide additional overlay details.
         */
        activelySending: new Map()
      },
      markers
    };
  },

  /**
   * Move the message into the outbox and enqueue a marker if we're not
   * paused.
   */
  async _planSend(ctx, persistentState, memoryState, rawTask) {
    const { messageId } = rawTask;
    // -- Load the conversation, put the message in the outbox, re-churn.
    let convId = convIdFromMessageId(messageId);
    let fromDb = await ctx.beginMutate({
      conversations: new Map([[convId, null]]),
      messagesByConversation: new Map([[convId, null]])
    });
    let oldConvInfo = fromDb.conversations.get(convId);
    let messages = fromDb.messagesByConversation.get(convId);
    let messageInfo = messages.find(msg => msg.id === messageId);

    let foldersToc =
      await ctx.universe.acquireAccountFoldersTOC(ctx, ctx.accountId);
    let outboxFolder = foldersToc.getCanonicalFolderByType('outbox');
    messageInfo.folderIds = new Set([outboxFolder.id]);
    // Reset the sending problems; we'll assume the user fixed things.
    messageInfo.draftInfo.sendProblems = {
      error: null,
      badAddresses: null,
      sendFailures: 0
    };

    let convInfo = churnConversation(convId, oldConvInfo, messages);

    // -- Track that we want to send the message
    let sendInfo = {
      date: messageInfo.date,
      order: persistentState.sendOrderingCounter++
    };
    persistentState.messageIdsToSend.set(messageId, sendInfo);

    // -- Generate a marker
    let modifyTaskMarkers = new Map();
    // If we're paused, do not issue the marker yet.  The marker will be
    // issued when we unpause.
    if (!memoryState.paused) {
      let marker = this._makeMarkerForMessage(
        rawTask.accountId, messageId, sendInfo.order);
      modifyTaskMarkers.set(marker.id, marker);
    }

    // Provide a result to the caller that lets them know
    let reportProblem;
    if (memoryState.paused) {
      reportProblem = 'outbox-paused';
    } else if (ctx.accountProblem) {
      reportProblem = 'account-problem';
    } else if (!ctx.online) {
      reportProblem = 'offline';
    } else {
      reportProblem = null;
    }

    await ctx.finishTask({
      mutations: {
        conversations: new Map([[convId, convInfo]]),
        messages: new Map([[messageId, messageInfo]])
      },
      taskMarkers: modifyTaskMarkers,
      complexTaskState: persistentState
    });
    return ctx.returnValue(reportProblem);
  },


  /**
   * Move the message back into drafts and clear the marker.
   */
  async _planAbort(ctx, persistentState, memoryState, rawTask) {
    const { messageId } = rawTask;
    // -- We're moot if we've already sent the message
    if (!persistentState.messageIdsToSend.has(messageId)) {
      throw new Error('moot');
    }

    // -- If we're actively sending...
    // For now, just act like the message is irrecovably sent.  A better thing
    // to do would be to mark a persistent desire to abort the message in the
    // event that we experience a transient failure.  However, that does have
    // some UX ambiguity and complicates things, so it might be best to just
    // directly abort the other task if we can.
    // TODO: address aborting.  pointless right now since we're not parallel
    // yet and this really wants thorough unit tests for sanity.
    if (memoryState.activelySending.has(messageId)) {
      throw new Error('moot');
    }

    // -- Move it back to drafts and re-churn
    let convId = convIdFromMessageId(messageId);
    let fromDb = await ctx.beginMutate({
      conversations: new Map([[convId, null]]),
      messagesByConversation: new Map([[convId, null]])
    });
    let oldConvInfo = fromDb.conversations.get(convId);
    let messages = fromDb.messagesByConversation.get(convId);
    let messageInfo = messages.find(msg => msg.id === messageId);

    let foldersToc =
      await ctx.universe.acquireAccountFoldersTOC(ctx, ctx.accountId);
    let draftsFolder = foldersToc.getCanonicalFolderByType('localdrafts');
    messageInfo.folderIds = new Set([draftsFolder.id]);
    // Note that we do not zero out the sendProblems because anything in there
    // is still going to be accurate.  Triggering the abort is just moving
    // the message back into the drafts folder so the user can edit the
    // message.  They will not have been able to do anything about the problem
    // while it was in the outbox.

    let convInfo = churnConversation(convId, oldConvInfo, messages);

    // -- Clear the send marker
    let markerId = this._markerIdForMessage(messageId);
    persistentState.messageIdsToSend.delete(messageId);

    await ctx.finishTask({
      mutations: {
        conversations: new Map([[convId, convInfo]]),
        messages: new Map([[messageId, messageInfo]])
      },
      taskMarkers: new Map([[markerId, null]]),
      complexTaskState: persistentState
    });
  },

  async _planSetPaused(ctx, persistentState, memoryState, rawTask) {
    // If we're already in the desired state, we can just bail.
    if (rawTask.paused === memoryState.paused) {
      await ctx.finishTask({
      });
      return;
    }

    // -- Mess with the markers
    // Our persistent state messageIdsToSend always accurately reflects the
    // set of messages we want to send and the set of markers we have issued
    // if we are not paused.
    let bePaused = memoryState.paused = rawTask.paused;
    let modifyTaskMarkers = new Map();
    if (bePaused) {
      // - Clear all our existing markers.
      // We want the task manager to stop trying to execute these until we
      // unpause.  When we unpause, we'll reissue them.
      // (Note: There's no harm in trying to clear a marker that's actively
      // being sent.)
      for (let messageId of persistentState.messageIdsToSend.keys()) {
        modifyTaskMarkers.set(this._markerIdForMessage(messageId), null);
      }
    } else {
      // - Reissue markers for the to-sends from our persistent state.
      let accountId = ctx.accountId;
      for (let [messageId, { order }] of
           persistentState.messageIdsToSend) {
        let marker = this._makeMarkerForMessage(accountId, messageId, order);
        modifyTaskMarkers.set(marker.id, marker);
      }
    }

    await ctx.finishTask({
      taskMarkers: modifyTaskMarkers,
      complexTaskState: persistentState
    });
  },

  plan(ctx, persistentState, memoryState, rawTask) {
    switch (rawTask.command) {
      case 'send': {
        return this._planSend(ctx, persistentState, memoryState, rawTask);
      }
      case 'abort': {
        return this._planAbort(ctx, persistentState, memoryState, rawTask);
      }
      case 'setPaused': {
        return this._planSetPaused(ctx, persistentState, memoryState,
                                   rawTask);
      }
      default:
        throw new Error('bug');
    }
  },

  /**
   * The actual online sending of the message.
   *
   * There are a few ways this ends:
   * - The message is sucessfully sent.  One of the following happens for the
   *   sent folder:
   *   - We trust the sending server to have handled it for us.  This is the
   *     case for Gmail, IMAP/CoreMail, and ActiveSync.  Note that for
   *     implementation simplicity we currently do not speculatively create an
   *     offline copy of the message.  In practice this may also prove
   *     impossible or misguided.
   *   - We have to upload the message to the sent folder ourselves.  This is
   *     the default for IMAP.
   *   - We're dealing with local-only POP3 and put a copy in the sent folder.
   * - The message fails to send.  It stays in the outbox!
   */
  async execute(ctx, persistentState, memoryState, marker) {
    const { messageId } = marker;
    const { date } = persistentState.messageIdsToSend.get(messageId);

    // -- Claim the message as sending
    const activeSendStatus = {
      progress: 'building'
    };
    memoryState.activelySending.set(messageId, activeSendStatus);

    // -- Acquire the account
    const account = await ctx.universe.acquireAccount(ctx, ctx.accountId);

    // -- Retrieve the message (not for mutation)
    let messageKey = [messageId, date];
    let messageInfo = (await ctx.read({
      messages: new Map([[messageKey, null]])
    })).messages.get(messageId);

    // -- Create the composer.
    const renewWakeLock = ctx.heartbeat.bind(ctx);
    const composer = new Composer(messageInfo, account, renewWakeLock);

    // We have the composer create the MIME message structure here for hacky
    // control flow reasons.  SMTP wants the envelope which needs the MIME
    // structure built, but when we moved to storing the contents of the
    // body parts in Blobs, what was previously synchronous became asynchronous.
    // So we just get this out of the way here.  There is nothing clever about
    // this and revisiting is absolutely appropriate as needed.
    await composer.buildMessage({
      includeBcc: this.shouldIncludeBcc(account)
    });

    // -- Perform the send.
    let { error: sendError, badAddresses } =
      await this.sendMessage(ctx, account, composer);

    // -- Acquire the message and conversation for exclusive mutation.
    let convId = convIdFromMessageId(messageId);
    let fromDb = await ctx.beginMutate({
      conversations: new Map([[convId, null]]),
      messagesByConversation: new Map([[convId, null]])
    });
    let messages = fromDb.messagesByConversation.get(convId);
    let oldConvInfo = fromDb.conversations.get(convId);
    // Update our messageInfo reference in case there was a racing write.
    // NB: Obviously, any changes since when we acquired it could potentially
    // be bad news.  We choose to err on the side of not losing information.
    messageInfo = messages.find(msg => msg.id === messageId);

    let newTasks = [];
    let modifyMessages = new Map();
    let modifyConversations = new Map();
    if (sendError) {
      // -- On error, update draftInfo and re-churn.
      switch (sendError) {
        // Bad messages and bad addresses are persistent failures.
        case 'bad-message':
        case 'bad-address':
          break;

        // An account problem should be retried once the account is fixed.
        // We can convey this just with a marker dependency.
        case 'bad-user-or-pass':
          // XXX
          break;

        // Transient problems that may resolve themselves if we try again
        // later.  (Note that for bad security we're assuming the least-bad
        // scenario of a captival portal messing with us by doing this.)
        case 'bad-security':
        case 'server-maybe-offline':
        case 'unresponsive-server':
        // Let's also treat unknown as a transient failure.
        case 'unknown':
        default:
          // XXX
          break;
      }

      messageInfo.draftInfo.sendProblems = {
        state: 'error',
        error: sendError,
        badAddresses,
      };
    } else {
      // -- Success, decide how we're putting something in sent.
      this.saveSentMessage(
        { ctx, newTasks, messages, messageInfo, account });

      // -- Re-churn or delete the conversation as appropriate.
      // We have a weird contract with saveSentMessage:
      // * If messageInfo is no longer in messages, that means that the message
      //   is being deleted.
      // * As a side-effect of that, if there are no longer any messages in the
      //   conversation, we reap the conversation.
      if (messages.length) {
        if (messages.indexOf(messageInfo) !== -1) {
          // - The message is still in there
          // (There is no case where we don't modify the message if we're
          // keeping it around.)
          modifyMessages.set(messageId, messageInfo);
        } else {
          // - The message is deleted
          modifyMessages.set(messageId, null);
        }
        // Re-churn the conversation no matter what
        let convInfo = churnConversation(convId, oldConvInfo, messages);
        modifyConversations.set(convId, convInfo);
      } else {
        // - Delete the conversation
        // This also implicitly kills the message.  Easy peasy.
        modifyConversations.set(convId, null);
      }
    }

    // -- Be done
    persistentState.messageIdsToSend.delete(messageId);
    memoryState.activelySending.delete(messageId);
    await ctx.finishTask({
      mutations: {
        conversations: modifyConversations,
        messages: modifyMessages
      },
      newData: {
        tasks: newTasks
      },
      complexTaskState: persistentState
    });
  },

  /**
   * By default, use the sendMessage method on the account.  While I wouldn't
   * call this legacy, ActiveSync's new smotocol approach favors not involving
   * the account, so we let tasks do what they want.
   */
  sendMessage(ctx, account, composer) {
    return account.sendMessage(composer);
  },

  /**
   * Our default behaviour is to delete the message from the conversation,
   * potentially deleting the conversation as a result.  This is appropriate for
   * cases where the act of sending automatically saves the message in the sent
   * folder on the server (and we're too lazy to implement reconciliation of our
   * local understanding with what ends up happening on the server.)
   */
  saveSentMessage({ messages, messageInfo }) {
    messages.splice(messages.indexOf(messageInfo), 1);
  }
};

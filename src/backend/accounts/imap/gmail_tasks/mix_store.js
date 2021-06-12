import { numericUidFromMessageId } from 'shared/id_conversions';

import { normalizeAndApplyChanges, applyChanges, mergeChanges } from
  '../../../delta_algebra';
import { selectMessages } from '../../../message_selector';

import churnConversation from '../../../churn_drivers/conv_churn_driver';

/**
 * @typedef {} MixStorePersistentState
 * @prop {Number} nextId
 *   The next number to combine with our task type/name and the account id to
 *   produce a marker id.  Practically speaking, we could use the aggregating
 *   string instead of this, but labels/flags are potentially very-private and
 *   so it is not safe to encode them into the id's given how we want to be able
 *   to safely log those ids.
 * @prop {Map<MixStoreAggrString, MixStoreChangeAggr>} aggrChanges
 *
 * We aggregate the manipulations we want to perform to leverage IMAP's ability
 * to batch things.  If two separate store requests would issue the same IMAP
 * command (apart from the UID identifier), they should end up in the same
 * FlagChangeAggr.
 */
/**
 * @typedef {String} MixStoreAggrString
 *
 * The unique string derived from the add/remove flags that characterizes the
 * operation.
 */
/**
 * @typedef {Object} MixStoreChangeAggr
 *
 * @property {String} id
 *   The marker identifier for this job, made up of our task type/name, the
 *   account id for this state instance, and the `nextId` in our persistent
 *   state.
 * @property {Array<String>} add
 *   The flags/labels to add.
 * @property {Array<String>} remove
 *   The flags/labels to remove.
 * @property {Array<ImapUid>} uids
 *   The messages we want to perform this operation on.
 */

/**
 * @typedef {Map<ImapUid, MixStoreAggrString>} MixStoreMemoryState
 *
 * Maps tracked SUIDs to their current aggregation string so we can easily
 * find what we want to do with them when unifying or mooting.
 */


/**
 * @typedef {Object} MixStoreRequest
 *
 * @property {AccountId} accountId
 *   Account identifier, required for all tasks for binning purposes.
 * @property {ConversationId} convId
 *   The conversation to be manipulated
 * @property {Array<MessageId>} [onlyMessages]
 *   If this shouldn't be applied to the entire conversation, the list of
 *   messages to manipulate.  Null if no filtering is needed.
 * @property {Array<String>} add
 *   The flags/labels to add.
 * @property {Array<String>} remove
 *   The flags/labels to remove.
 */

/**
 * For gmail, flag and label manipulation are nearly identical.  Rather than
 * having the task handle both directly, we use mixins.
 *
 * This complex task is not priority aware.  It's our goal to reflect all user
 * manipulations of state to the server, and it does not matter what order it
 * happens in.  This is made into a safe assumption by these tasks exposing a
 * method to apply our pending local changes to the information we receive from
 * the server.
 *
 * ## Conversation / Message Granularity ##
 *
 * ### How does gmail work?!?! ###
 *
 * At least back in the day (2009/2010) per some support threads:
 * - The conversations web UI shows conversations based on a union of those
 *   labels.
 * - Applying a label to a conversation applies the labels on the messages then
 *   in the conversation.
 * - New messages in the conversation do not magically receive those labels.
 *   (There may be a filter/rule that applies the labels uniformly, but that's
 *   it.)
 * - A particular example of this was sent messages.  They would not get the
 *   magic label and really confuse IMAP clients.
 *
 * ### Okay, let's do what gmail does ###
 *
 * Yeah, that works for me.  The standard idiom shall be to apply labels across
 * all things.
 *
 * ### Optimizing based on that assumption ###
 *
 * The local task has to manipulate the ConversationInfo and MessageInfo
 * structures.  Accordingly, it makes sense to issue the request on the
 * conversation itself.
 *
 * Once planned, we no longer actually need to orient along conversation lines.
 * We can split out based on UID (and for Trash/Spam, a tuple of folderId and
 * UID or something like that.)  This coincidentally is exactly what the sync
 * logic wants from us.  Hooray!
 *
 * ## Normalization of flags/labels ##
 *
 * The execute stage uses the IMAP strings we will tell the server, which is
 * the label string and/or flag name.
 *
 * The planning stage for labels deals in folderIds (an opaque string) as its
 * inputs.  Tags stay the same string all the way through.  This difference is
 * handled by a custom method by our consumers.
 *
 * ## Pending Changes and Sync ##
 *
 * When it comes to the apparent flags/labels on a message, we have the
 * following consumers and needs:
 * - The set of interesting messages/conversations is impacted by the
 *   flags/labels: sync_refresh and sync_grow
 * - The set of flags/labels reported to the UI is impacted (but it's too late)
 *   for this to impact anything: sync_conv
 *
 * Important invariants:
 * - Consistency of our local database with the server for a given modseq
 *   requires that if we interfere with sync_refresh/sync_grow's perception of
 *   reality that when we remove that state that we are able to undo any side
 *   effects of that altered perception.
 *
 * Relevant observations:
 * - In order for a user to be able to manipulate a message and state to end up
 *   in here, they have to be able to see the message.  This inherently means
 *   that the conversation is already known to us.
 * - The most upsetting thing to a user is if they have told us to mutate some
 *   state and they don't see it reflected in the UI promptly and consistently.
 *   The v1 implementation could result in flapping as the local change was
 *   applied, sync clobbered the state to the server state, the online operation
 *   was then run, and then the next sync clobbered it back to the desired
 *   state.
 *   - Therefore, the most important changes are metadata changes and (apparent)
 *     deletion (usually label removing, but also moving to trash/spam which are
 *     more irrevocable).
 * - Until gmail supports QRESYNC, our deletion-inference mechanism will help
 *   avoid worst-case database inconsistencies.
 *
 * Conclusions:
 * - Metadata like read and flagged status are easy peasy.  (At least, if we
 *   don't sync on those virtual folders.)
 * - Apparent deletion via removal of a label that still leaves the conversation
 *   interesting to us is not a problem.
 * - Apparent deletion that makes the conversation no longer interesting seems
 *   complex, but is not:
 *   - By applying the flag/label transform to the message id/uid we are able to
 *     impact the view of the world in a consistent fashion.
 *   - There is no case where we need to make the sync process hear about things
 *     that aren't real.  If we needed to insert synthetic data, we can do that
 *     at any time in our local store.  Our only need is to ensure that what the
 *     server tells us is transformed to not clobber our local state.  (And
 *     ensure we don't resource leak data.)
 *
 * Therefore, we implement:
 * -
 */
const GmailStoreTaskMixin = {
  /**
   * @return {StoreFlagState}
   *   The initial state of this task type for a newly created account.
   */
  initPersistentState() {
    return {
      nextId: 1,
      aggrChanges: new Map()
    };
  },

  deriveMemoryStateFromPersistentState(persistentState, accountId) {
    let markers = [];
    let idToAggrString = new Map();

    for (let [aggrString, change] of persistentState.aggrChanges) {
      for (let uid of change.uids) {
        idToAggrString.set(uid, aggrString);
      }
      markers.push({
        type: this.name,
        id: change.id,
        accountId: accountId,
        aggrString: aggrString,
        priorityTags: [],
        exclusiveResources: []
      });
    }

    return {
      memoryState: {
        idToAggrString
      },
      markers
    };
  },

  /**
   * Compute a string we can use to cluster the requests.
   *
   * The key thing is not to accidentally allow collisions.  This requires
   * either escaping or use of otherwise illegal characters for delimiters.  We
   * escape using JSON.stringify since that most resembles what imap-handler
   * does for atom escaping.
   *
   * @param {Array<String>} [add]
   *   The strings being added.  This array will be sorted in-place, so callers
   *   need to be aware of that.  Which our internal callers are.
   * @param {Array<String>} [remove]
   *   The strings being removed.  Same mutating sort deal as for `add`.
   *
   * @return {FlagStoreAggrString}
   */
  _deriveMixStoreAggrString(add, remove) {
    var s = '';
    if (add && add.length) {
      add.sort();
      s += add.map(x => '+' + JSON.stringify(x)).join(' ');
    }
    if (remove && remove.length) {
      // add delimiting whitespace for sanity if we have both types
      if (add && add.length) {
        s += ' ';
      }
      s += remove.map(x => 'x' + JSON.stringify(x)).join(' ');
    }
    return s;
  },

  async plan(ctx, persistentState, memoryState, req) {
    let { aggrChanges } = persistentState;
    let { idToAggrString } = memoryState;

    // (only needed in the labels case currently, but )
    let normalizeHelper =
      await this.prepNormalizationLogic(ctx, req.accountId);

    // -- Load the conversation and messages
    let fromDb = await ctx.beginMutate({
      conversations: new Map([[req.convId, null]]),
      messagesByConversation: new Map([[req.convId, null]])
    });

    let loadedMessages = fromDb.messagesByConversation.get(req.convId);
    let modifiedMessagesMap = new Map();
    let modifyTaskMarkers = new Map();
    let anyMessageChanged = false;

    // - Apply the message selector if applicable
    let filteredMessages = selectMessages(
      loadedMessages, req.onlyMessages, req.messageSelector);

    const attrName = this.attrName;
    let undoTasks = [];
    // -- Per message, compute the changes required and issue/update markers
    for (let message of filteredMessages) {
      let { add: actuallyAdded, remove: actuallyRemoved } =
        normalizeAndApplyChanges(message[attrName], req.add, req.remove);

      if (actuallyAdded || actuallyRemoved) {
        // - Generate (non-minimal) undo tasks
        // (It's way too much work to optimize the undo case.)
        undoTasks.push({
          type: this.name,
          accountId: req.accountId,
          convId: req.convId,
          onlyMessages: [message.id],
          messageSelector: null,
          // invert the manipulation that was actually performed
          add: actuallyRemoved && actuallyRemoved.concat(),
          remove: actuallyAdded && actuallyAdded.concat()
        });

        // Normalize to server-name space from our local name-space.  AKA
        // convert folder id's to gmail labels in the label case and do nothing
        // in the flags case.
        actuallyAdded =
          this.normalizeLocalToServer(normalizeHelper, actuallyAdded);
        actuallyRemoved =
          this.normalizeLocalToServer(normalizeHelper, actuallyRemoved);

        modifiedMessagesMap.set(message.id, message);
        anyMessageChanged = true;

        let uid = numericUidFromMessageId(message.id);
        // - Unify with existing requests
        // If the change is already pending, then we need to remove it from that
        // bucket, merging the already pending changes when determining our new
        // bucket.
        if (idToAggrString.has(uid)) {
          let pendingAggrString = idToAggrString.get(uid);
          let pendingChanges = aggrChanges.get(pendingAggrString);

          ({ add: actuallyAdded, remove: actuallyRemoved} =
            mergeChanges(pendingChanges,
                         { add: actuallyAdded, remove: actuallyRemoved }));

          // remove from pending changes (possibly wiping the entry)
          pendingChanges.uids.splice(pendingChanges.uids.indexOf(uid));
          if (pendingChanges.uids.length === 0) {
            aggrChanges.delete(pendingAggrString);
            // mark the marker for removal
            modifyTaskMarkers.set(pendingChanges.id, null);
          }
        }

        // - Bucket it (if there's something to do)
        // (Change merges if there was pending changes could mean we don't
        // actually need to modify anything on the server.)
        if (actuallyAdded || actuallyRemoved) {
          let newAggrString = this._deriveMixStoreAggrString(
            actuallyAdded, actuallyRemoved);
          let newChanges;
          if (aggrChanges.has(newAggrString)) {
            newChanges = aggrChanges.get(newAggrString);
            newChanges.uids.push(uid);
          }
          else {
            newChanges = {
              id: this.name + ':' + req.accountId + persistentState.nextId++,
              add: actuallyAdded,
              remove: actuallyRemoved,
              uids: [uid]
            };
            aggrChanges.set(newAggrString, newChanges);
          }
          idToAggrString.set(uid, newAggrString);
          modifyTaskMarkers.set(
            newChanges.id,
            {
              type: this.name,
              id: newChanges.id,
              accountId: req.accountId,
              aggrString: newAggrString,
              priorityTags: [],
              exclusiveResources: []
            });
        }
      }
    } // (end per-message loop)

    let conversationsMap = null;
    if (anyMessageChanged) {
      let oldConvInfo = fromDb.conversations.get(req.convId);
      let convInfo = churnConversation(
        req.convId, oldConvInfo, loadedMessages);
      conversationsMap = new Map([[convInfo.id, convInfo]]);
    }

    // (The local database state will already include any accumulated changes
    // requested by the user but not yet reflected to the server.  There is no
    // need to perform any transformation based on what is currently pending
    // because inbound sync does that and so we always seem a post-transform
    // view when looking in our database.)
    await ctx.finishTask({
      mutations: {
        conversations: conversationsMap,
        messages: modifiedMessagesMap
      },
      taskMarkers: modifyTaskMarkers,
      complexTaskState: persistentState,
      undoTasks: undoTasks
    });
  },

  /**
   * Exposed helper API for sync logic that wants the list of flags/labels
   * fixed-up to account for things we have not yet reflected to the server.
   */
  consult(askingCtx, persistentState, memoryState, argDict) {
    let { uid, value } = argDict;

    let { aggrChanges } = persistentState;
    let { idToAggrString } = memoryState;

    if (idToAggrString.has(uid)) {
      let aggrString = idToAggrString.get(uid);
      let changes = aggrChanges.get(aggrString);

      applyChanges(value, changes);
    }
  },

  async execute(ctx, persistentState, memoryState, marker) {
    let { aggrChanges } = persistentState;
    let { idToAggrString } = memoryState;

    let changes = aggrChanges.get(marker.aggrString);

    let account = await ctx.universe.acquireAccount(ctx, marker.accountId);
    // TODO: spam and trash folder handling would demand that we perform
    // further normalization of the UIDs and pick the appropriate folder here.
    let allMailFolderInfo = account.getFirstFolderWithType('all');
    let uidSet = changes.uids;

    // -- Issue the manipulations to the server
    if (changes.add && changes.add.length) {
      await account.pimap.store(
        ctx,
        allMailFolderInfo,
        uidSet,
        '+' + this.imapDataName,
        changes.add,
        { byUid: true });
    }
    if (changes.remove && changes.remove.length) {
      await account.pimap.store(
        ctx,
        allMailFolderInfo,
        uidSet,
        '-' + this.imapDataName,
        changes.remove,
        { byUid: true });
    }

    // - Success, clean up state.
    aggrChanges.delete(marker.aggrString);
    for (let uid of changes.uids) {
      idToAggrString.delete(uid);
    }

    // - Return / finalize
    await ctx.finishTask({
      complexTaskState: persistentState
    });
  }
};

export default GmailStoreTaskMixin;

define(function(require) {
'use strict';

let co = require('co');

/**
 * @typedef {Map<MixStoreAggrString, MixStoreChangeAggr>} MixStorePersistentState
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
 * @property {Array<String>} add
 *   The flags/labels to add.
 * @property {Array<String>} remove
 *   The flags/labels to remove.
 * @property {Array<SUID>} messages
 *   The messages we want to perform this operation on.
 */

/**
 * @typedef {Map<SUID, MixStoreAggrString>} MixStoreMemoryState
 *
 * Maps tracked SUIDs to their current aggregation string so we can easily
 * find what we want to do with them when unifying or mooting.
 */


/**
 * @typedef {Object} MixStoreRequest
 *
 * @property {Array<String>} add
 *   The flags/labels to add.
 * @property {Array<String>} remove
 *   The flags/labels to remove.
 * @property {Array<SUID>} messages
 *   The messages this request is being targeted for.
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
let GmailStoreTaskMixin = {

  /**
   * @return {StoreFlagState}
   *   The initial state of this task type for a newly created account.
   */
  initPersistentState: function() {
    return {
      nextId: 1,

    };
  },

  deriveMemoryStateFromPersistentState: function(persistentState) {
    let markers = [];
    return markers;
  },

  /**
   * Compute a string we can use to cluster the requests.
   *
   * The key thing is not to accidentally allow collisions.  This requires
   * either escaping or use of otherwise illegal characters for delimiters.  We
   * escape using JSON.stringify since that most resembles what imap-handler
   * does for atom escaping.
   *
   * @return {FlagStoreAggrString}
   */
  _deriveMixStoreAggrString: function(req) {
    var s = '';
    s += req.add.map(x => '+' + JSON.stringify(x)).join(' ');
    if (req.add.length && req.remove.length) {
      s += ' ';
    }
    s += req.remove.map(x => 'x' + JSON.stringify(x)).join(' ');
    return s;
  },

  plan: co.wrap(function*(ctx, persistentState, memoryState, request) {
    // -- Load the conversation and messages
    let fromDb = yield ctx.beginMutate({
      conversations: new Map([[req.convId, null]]),
      messagesByConversation: new Map([[req.convId, null]])
    });

    let loadedMessages = fromDb.messagesByConversation.get(req.convId);
    let modifiedMessagesMap = new Map();

    // -- Per message, compute the changes required and issue/update markers
    for (let message of loadedMessages) {
    }
    // (The local database state will already include any accumulated changes
    // requested by the user but not yet reflected to the server.  There is no
    // need to perform any transformation based on what is currently pending
    // because inbound sync does that and so we always seem a post-transform
    // view when looking in our database.)

    // See
  }),

  execute: function(ctx, persistentState, memoryState, marker) {
    let account = yield ctx.universe.acquireAccount(ctx, marker.accountId);
    let allMailFolderInfo = account.getFirstFolderWithType('all');

  }
};

return GmailStoreTaskMixin;
});

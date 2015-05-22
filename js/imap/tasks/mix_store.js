define(function(require) {
'use strict';

/**
 * @typedef {Map<FlagStoreAggrString, FlagChangeAggr>} MixStorePersistentState
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
 *   reality that when we remove that state that we are able to
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
 * Conslusions:
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
  name: 'store_flags',
  /**
   * @return {StoreFlagState}
   *   The initial state of this task type for a newly created account.
   */
  initPersistentState: function() {
    return new Map();
  },

  deriveMemoryStateFromPersistentState: function(persistentState) {
    return new Map();
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

  /**
   * Process the provided request
   */
  plan: function(ctx, persistentState, memoryState, request) {

  },

  execute: function(ctx, persistentState, memoryState, marker) {

  }
};

return GmailStoreTaskMixin;
});

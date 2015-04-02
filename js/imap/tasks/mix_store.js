define(function(require) {

let TaskDefiner = require('../../task_definer');

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
 * For gmail, flag and label manipulation is nearly identical.  Rather than
 * having the task handle both directly, mixins for the win.
 */
let GmailStoreTaskMixin = {
  name: 'store_flags',
  /**
   * @return {StoreFlagState}
   *   The initial state of this task type for a newly created account.
   */
  initPersistentStateForAccount: function(account)) {
    return new Map();
  },

  deriveMemoryStateFromPersistentState: function(account, persistentState) {
    
  },

  hasWork: function(account, persistentState) {
    return persistentState.size > 0;
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
  }

  /**
   * Process the provided request
   */
  planTask: function(account, perstate, memstate, request) {

  },

  moot_message: function(account, perstate, memstate, suid) {
    function goMoot(map, suid) {
      if (map.has(suid)) {

        return true;
      }
      return false;
    }

    return goMoot(memstate.flags) ||
           goMoot(memstate.labels);
  }
});

return GmailStoreTaskMixin;
});

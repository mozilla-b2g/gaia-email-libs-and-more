define(function(require) {

var TaskDefiner = require('../../task_definer');

/**
 * @typedef {Object} StoreFlagsPersistentState
 * @property {PerFlagStorePersistentState} flags
 *   Standard IMAP flag changes.
 * @property {PerFlagStorePersistentState} labels
 *   Gmail specific label changes.
 */
/**
 * @typedef {Map<FlagStoreAggrString, FlagChangeAggr> PerFlagPersistentState
 *
 * We aggregate the manipulations we want to perform to leverage IMAP's ability
 * to batch things.  If two separate store_flags requests would issue the same
 * IMAP command (apart from the UID identifier), they should end up in the same
 * FlagChangeAggr.
 */
/**
 * @typedef {String} FlagStoreAggrString
 *
 * The unique string derived from the add/remove flags that characterizes the
 * operation.
 */
/**
 * @typedef {Object} FlagChangeAggr
 *
 * @property {Array<String>} add
 *   The flags to add.
 * @property {Array<String>} remove
 *   The flags to remove.
 * @property {Array<SUID>} messages
 *   The messages we want to perform this operation on.
 */

/**
 * @typedef {Object} StoreFlagsMemoryState
 * @property {PerFlagStoreMemoryState} flags
 *   Standard IMAP flag changes.
 * @property {PerFlagStoreMemoryState} labels
 *   Gmail specific label changes.
 */
/**
 * @typedef {Map<SUID, FlagStoreAggrString>} PerFlagStoreMemoryState
 *
 * Maps tracked SUIDs to their current aggregation string so we can easily
 * find what we want to do with them when unifying or mooting.
 */


/**
 * @typedef {Object} StoreFlagsRequest
 * @property {"flags"|"labels"} type
 *   The type of manipulation being requested.
 * @property {Array<SUID>} messages
 *   The messages this request is being targeted for.
 * @property
 */

/**
 * Flag manipulations are
 */
var GmailStoreFlagsTask = TaskDefiner.defineCleverTask({
  name: 'store_flags',
  /**
   * @return {StoreFlagState}
   *   The initial state of this task type for a newly created account.
   */
  initPersistentStateForAccount: function() {
    return {
      flags: new Map(),
      labels: new Map()
    };
  },

  deriveMemoryStateFromPersistentState: function(account, persistentState) {
    for (var )
  },

  hasWork: function(account, persistentState) {
    return persistentState.flags.size > 0 ||
           persistentState.labels.size > 0;
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
  _deriveFlagStoreAggrString: function(req) {
    var s = '';
    s += req.add.map(x => '+' + JSON.stringify(x)).join(' ');
    if (req.add.length && req.remove.length) {
      s += ' ';
    }
    s += req.remove.map(x => 'x' + JSON.stringify(x)).join(' ');
    return s;
  }

  unifyRequest: function(account, perstate, memstate, request) {

  }

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

return GmailStoreFlagsTask;
});

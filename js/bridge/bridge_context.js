define(function(require) {

let logic = require('../logic');

/**
 * Manages/tracks resources owned by a MailBridge on behalf of a MailAPI
 * instance on the other side of some connection.  Analogous to `TaskContext`
 * instances and explicitly exists for symmetry.  (This class is not trying to
 * replace MailBridge, but will hopefully help MailBridge become cleaner without
 * BridgeContext becoming a sprawling hackjob.)
 *
 * Things we manage / own:
 * - Track `RefedResource`s.
 */
function BridgeContext() {
  logic.defineScope(this, 'BridgeContext');

  this._stuffToRelease = [];
}
BridgeContext.prototype = {
  /**
   * Asynchronously acquire a resource and track that we are using it so that
   * when the task completes or is terminated we can automatically release all
   * acquired resources.
   */
  acquire: function(acquireable) {
    this._stuffToRelease.push(acquireable);
    return acquireable.__acquire(this);
  },

  _releaseEverything: function() {
    for (let acquireable of this._stuffToRelease) {
      try {
        acquireable.__release(this);
      } catch (ex) {
        logic(this, 'problem releasing', { what: acquireable, ex: ex });
      }
    }
  },
};

return BridgeContext;
});

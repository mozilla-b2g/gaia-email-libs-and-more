define(function(require) {

/**
 * Manages/tracks resources owned by a MailBridge on behalf of a MailAPI
 * instance on the other side of some connection.  Analogous to `TaskContext`
 * instances and explicitly exists for symmetry.  (This class is not trying to
 * replace MailBridge, but will hopefully help MailBridge become cleaner without
 * BridgeContext becoming a sprawling hackjob.)
 *
 * Things we manage / own:
 * - Track `RefedResource`s.
 * - Handle "releasing" EntireListProxy/WindowedListProxy batch updates.
 *   Previously SliceBridgeProxy instances did their own
 */
function BridgeContext() {

}
BridgeContext.prototype = {

};

return BridgeContext;
});

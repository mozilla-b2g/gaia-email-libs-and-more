define(function(require) {
'use strict';
/**
 * Data overlays are bonus data that may change with a high frequency that we
 * send to the front-end along-side our more persistent database records (which
 * necessarily change with a lower frequency.)  The information in data overlays
 * is currently always derived from complex tasks, but in the future, it might
 * also come from some type of extension like a caching-bugzilla-looker-upper.
 *
 * Overlays work in both a push and a pull capacity:
 * - Pull: We want to send a database record (ex: a MessageInfo) to the
 *   front-end.  In this case, we generate the overlay data on demand as we
 *   flush the records.
 * - Push: A complex task that publishes data overlays has experienced a change
 *   and so it wants to update any interested data overlays.  It tells us and
 *   we emit an appropriate event for any interested list proxies.
 *
 * Each front-end object receives the wire representation of its state (which
 * may be its DB state, but not always like when the account info would
 * otherwise include the password) plus a data overlay dictionary.  Each key in
 * the dictionary is the name of the task providing overlay data, and the value
 * is the value provided to us.
 *
 * In the case of ConversationInfo records, which are an app_logic controlled
 * aggregate, we currently simply have the tasks also expose appropriate
 * aggregate-level information as an overlay.  However, in the future, it might
 * make sense to allow the app_logic to also provide a similar mechanism to the
 * conv_churn but also for overlays.  Right now we believe all the overlay
 * information is universally desired, so there's no real benefit to providing
 * the ability to break that information.  (And in fact, we may change the
 * operation of the conv_churn somewhat so that only parts of it are app_logic
 * controlled.)
 *
 * ## Task Hookup ##
 *
 * For pull purposes, tasks are automatically registered with us by naming
 * convention on the tasks.  With the assistance of the TaskRegistry we consult
 * the tasks, providing them with the current state of the database record we
 * want overlay information about.  (Mainly for future enhancement reasons.)
 *
 * Pushes go in one of the arguments to `TaskContext.finishTask`.  Right now
 * this does mean that the payloads are fully built even if they don't need
 * to be.  Currently the payloads are not expected to be particularly expensive
 * and the simplicity for our implementation is deemed beneficial.
 *
 * Note that in the pull case, rather than actually pulling, we could
 * alternately have `deriveMemoryStateFromPersistentState` generate a list of
 * current overlays and latch those values, updating them as push updates occur.
 * This would result in a higher memory usage, and have minor performance.  The
 * explicit pull structuring seems most beneficial for future enhancement cases
 * where on-demand-annotation logic could do raindrop-type things like looking
 * up the current state of Bugzilla bugs to annotate them onto the message /
 * conversation state, complete with clever caching.
 */
function DataOverlayManager() {

}
DataOverlayManager.prototype = {

};

return DataOverlayManager;
});

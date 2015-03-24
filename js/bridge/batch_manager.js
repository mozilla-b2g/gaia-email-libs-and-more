define(function(require) {

/**
 * As EntireListProxy and WindowedListProxy have things to tell their MailAPI
 * counterpart they tell the BatchManager and it controls when they actually
 * trigger the flush.
 *
 * Originally SliceBridgeProxy instances would make these decisions themselves
 * and just use a combination of a size limit and a setZeroTimeout to schedule
 * their delivery.  However, the v1 sync mechanism was both 1) much more likely
 * to generate a bunch of events in a single turn of the event loop and 2)
 * unable to perform any type of consolidation or avoid generating waste.  Under
 * the v3 task architecture, sync is much more granular and the event loop will
 * turn a lot and the WindowedListProxy can avoid telling the front-end things
 * it doesn't need to know or telling it the same thing multiple times.
 *
 * For now this just uses a fixed 100ms timeout for batching.  Tests will
 * probably want to put things in a "flush immediately" mode or "flush
 * explicitly when I say/after some other stuff has happened".
 */
function BatchManager() {
  this._pendingProxies = new Set();
  this._timer = null;

  this._bound_timerFired = this._flushPending.bind(this, true);

  this.flushDelayMillis = 100;
}
BatchManager.prototype = {
  _flushPending: function(timerFired) {
    if (!timerFired) {
      window.clearTimeout(this._timer);
      this._timer = null;
    }

    for (let proxy of this._pendingProxies) {
      proxy.flush();
    }
    this._pendingProxies.clear();
  },

  heyMoreChangesTellMeWhenToFlush: function(proxy) {
    this._pendingProxies.add(proxy);

    if (!this._timer) {
      this._timer = window.setTimeout(this._bound_timerFired,
                                      this.flushDelayMillis);
    }
  }
};

return BatchManager;
});

define(function(require) {
'use strict';

let logic = require('logic');

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
function BatchManager(db) {
  logic.defineScope(this, 'BatchManager');

  this._db = db;
  this._pendingProxies = new Set();
  this._timer = null;

  this._bound_timerFired = this._flushPending.bind(this, true);
  this._bound_dbFlush = this._flushPending.bind(this, false);

  this.flushDelayMillis = 100;

  this._db.on('cacheDrop', this._bound_dbFlush);
}
BatchManager.prototype = {
  __cleanup: function() {
    this._db.removeListener('cacheDrop', this._bound_dbFlush);
  },

  _flushPending: function(timerFired) {
    if (!timerFired) {
      window.clearTimeout(this._timer);
    }
    this._timer = null;

    logic(
      this, 'flushing',
      {
        proxyCount: this._pendingProxies.size,
        // TODO: this is arguably expensive; investigate logic on-demand funcs
        tocTypes: Array.from(this._pendingProxies).map((proxy) => {
          return proxy.toc.type;
        })
      });
    for (let proxy of this._pendingProxies) {
      let payload = proxy.flush();
      if (payload) {
        proxy.ctx.sendMessage('update', payload);
      }
    }
    this._pendingProxies.clear();
  },

  /**
   * Register a dirty view, potentially triggering an immediate flush.
   *
   * You would want an immediate flush when servicing a request from the
   * front-end and therefore where latency is likely of the essence.
   */
  registerDirtyView: function(proxy, immediateFlush) {
    logic(
      this, 'dirtying',
      {
        tocType: proxy.toc.type,
        ctxName: proxy.ctx.name,
        immediateFlush: immediateFlush,
        alreadyDirty: this._pendingProxies.has(proxy)
      });

    this._pendingProxies.add(proxy);

    if (immediateFlush) {
      this._flushPending(false);
    } else if (!this._timer) {
      this._timer = window.setTimeout(this._bound_timerFired,
                                      this.flushDelayMillis);
    }
  }
};

return BatchManager;
});

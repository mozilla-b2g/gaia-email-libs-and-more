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
 *
 * TODO: Adapt root cause id mechanism to allow flushing to occur exactly when
 * appropriate and thereby cancel the timeout.  We will still always want
 * timeouts, however, since unbounded feedback delays suck.
 *
 * ROOT CAUSE ID BRAINSTORMING FROM IRC:
 8:14 PM <asuth> jrburke: you mean like an evt.on() triggered by the UI action was making the UI do stuff before api.accounts actually updated?
8:15 PM <asuth> if it helps I can have deleteAccount() return a promise that's resolved only after the api.accounts view should have been updated
8:17 PM <asuth> since there is indisputably some benefit towards letting the UI seem to take more time to hide some UI in order to avoid a flash-of-imminently-doomed-content
8:17 PM <asuth> in this case the BatchManager and its 100ms delay is probably conspiring to screw you over
8:17 PM <asuth> for accounts I can certainly have it perform an immediate flush
8:18 PM <asuth> and in general track whether changes are directly user-triggered or not and do direct flushes in that case
8:19 PM <asuth> the BatchManager dirty/flushing goal was intended more to cover cases like sync where we have a flood of changes that come from logically distinct tasks
8:20 PM <asuth> hm, actually, I think what I could do is improve on the timeout mechanism and attach a "rootCauseId" to stuff
8:20 PM <asuth> the BatchManager could flush if all pending things associated with the rootCauseId have been fully processed
8:20 PM <asuth> so in the case of a user deleting 1 account, we flush after just the one deletion task has completed.  in the case of a user deleting 1 message, same dea.  In the case of a user deleting 10 messages, we wait until all 10 have been processed
8:21 PM <asuth> so they all disappear at once rather than having them flicker out one by one
8:22 PM <asuth> and I could tie the promise you get from the manipulation to the Promise you're waiting on.
8:22 PM <asuth> er, bad phrasing.  I could tie the rootCauseId to the promise you're waiting on
8:23 PM <asuth> right now I would accomplish that by explicitly waiting on the tasks that are directly scheduled as a result of the request you issue
8:23 PM <asuth> but by tying it to the rootCauseId I can handle cascades too
 *
 */
function BatchManager(db) {
  logic.defineScope(this, 'BatchManager');

  this._db = db;
  this._pendingProxies = new Set();
  /**
   * When null, there's no timer scheduled.  When `true`, it means we scheduled
   * a Promise to do the flush.  Otherwise it's a number that's a timer handle
   * that we can use to invoke clearTimeout on.
   */
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
      globalThis.clearTimeout(this._timer);
    }
    this._timer = null;

    logic(
      this, 'flushing',
      {
        proxyCount: this._pendingProxies.size,
        // TODO: this is arguably expensive; investigate logic on-demand funcs
        tocTypes: Array.from(this._pendingProxies).map((proxy) => {
          return proxy.toc.type;
        }),
        timerFired
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
   * Register a dirty view, potentially accelerating the flush.
   *
   *
   * @param {false|'soon'|'immediate'} [flushMode=false]
   *   If false, we will use our regular flushing semantics.  If 'soon', we will
   *   use a setTimeout(0) in order to schedule it as soon as we can after
   *   letting all Promise/micro-task-based things run to completion.  If
   *   'immediate' we do it right now.  You would want an immediate flush when
   *   servicing a request from the front-end and where you are certain that the
   *   result answer is one of: final/stable, latency-sensitive, or preliminary
   *   but the final answer will take at least a user-perceptible amount of
   *   time.
   */
  registerDirtyView: function(proxy, flushMode) {
    logic(
      this, 'dirtying',
      {
        tocType: proxy.toc.type,
        ctxName: proxy.ctx.name,
        flushMode,
        alreadyDirty: this._pendingProxies.has(proxy)
      });

    this._pendingProxies.add(proxy);

    if (flushMode) {
      if (flushMode === 'immediate') {
        this._flushPending(false);
      } else if (this._timer !== true) { // therefore: flushMode === 'soon'
        // Our conditioanl means we're only in here if a promise isn't already
        // scheduled.
        if (this._timer) {
          // which means this is a timer we need to clear if truthy.
          globalThis.clearTimeout(this._timer);
        }
        Promise.resolve().then(() => { this._flushPending(false); });
        this._timer = true;
      }
    } else if (!this._timer) {
      this._timer = globalThis.setTimeout(this._bound_timerFired,
                                          this.flushDelayMillis);
    }
  }
};

return BatchManager;
});

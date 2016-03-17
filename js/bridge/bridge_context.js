define(function(require) {
'use strict';

let logic = require('logic');

function NamedContext(name, type, bridgeContext) {
  logic.defineScope(this, type,
                    { name: name, bridge: bridgeContext.bridge.name });
  this.name = name;
  this._bridgeContext = bridgeContext;
  this._active = true;

  this._stuffToRelease = [];
  this.__childContexts = [];

  /**
   * If the bridge is currently processing an async command for this context,
   * this is the promise.
   */
  this.pendingCommand = null;
  /**
   * Any commands not yet processed because we're waiting on a pendingCommand.
   */
  this.commandQueue = [];
}
NamedContext.prototype = {
  get batchManager() {
    return this._bridgeContext.batchManager;
  },

  get dataOverlayManager() {
    return this._bridgeContext.dataOverlayManager;
  },

  /**
   * Asynchronously acquire a resource and track that we are using it so that
   * when the task completes or is terminated we can automatically release all
   * acquired resources.
   */
  acquire: function(acquireable) {
    if (!this._active) {
      throw new Error('we have already cleaned up!');
    }

    this._stuffToRelease.push(acquireable);
    return acquireable.__acquire(this);
  },

  /**
   * Helper to send a message with the given `data` to the associated bridge
   * using the handle that names us.
   */
  sendMessage: function(type, data) {
    this._bridgeContext.bridge.__sendMessage({
      type: type,
      handle: this.name,
      data: data
    });
  },

  /**
   * Schedule a function to be run at cleanup-time.
   */
  runAtCleanup: function(func) {
    // Currently we normalize to a fakae acquireable instance, but if we start
    // doing more useful stuff with _stuffToRelease,
    this._stuffToRelease.push({
      __release: func
    });
  },

  /**
   * Run through the list of acquired stuff to release and release it all.
   */
  cleanup: function() {
    this._active = false;

    for (let acquireable of this._stuffToRelease) {
      try {
        acquireable.__release(this);
      } catch (ex) {
        logic(
          this, 'problemReleasing',
          { what: acquireable, ex, stack: ex && ex.stack });
      }
    }
  },
};

/**
 * In conjunction with its helper class, provides a mechanism for tracking
 * resources used by specific bridge handles.  NamedContext is intended to be
 * analogous to `TaskContext`.  (But this does not mean that the MailBridge
 * should be trying to do tasky things.)
 *
 * Things that end up using this:
 * - View proxies (EntireListProxy, WindowedListProxy)
 */
function BridgeContext({ bridge, batchManager, dataOverlayManager }) {
  logic.defineScope(this, 'BridgeContext', { name: bridge.name });
  this.bridge = bridge;
  this.batchManager = batchManager;
  this.dataOverlayManager = dataOverlayManager;

  this._namedContexts = new Map();
}
BridgeContext.prototype = {
  /**
   *
   * @param {String} name
   *   The context name/id.  This should usually be the MailAPI-allocated handle
   *   (which is namespaced by the bridge).
   * @param {String} type
   *   The context type, used as the label of the logic scope.  Get as generic
   *   or specific as your logging needs require.
   * @param {NamedContext} [parentContext=null]
   *   The parent context of this new context, specified to enable automated
   *   cleanup of this new child context when the parent is cleaned up.  This is
   *   intended for use with mechanisms like derived views where a single bridge
   *   request returns multiple logically separate abstractions but whose
   *   life-cycle is definitively bound to the root/parent.  It's also expected
   *   and fine if the individual child contexts are explicitly cleaned up.
   *   Cleanup via `cleanupNamedContext` is idempotent.
   *
   *   We're exposing this only on the `BridgeContext` rather than the
   *   NamedContexts because from a life-cycle perspective we want these child
   *   contexts all created up at the same time with the parent.
   */
  createNamedContext: function(name, type, parentContext) {
    let ctx = new NamedContext(name, type, this);
    this._namedContexts.set(name, ctx);
    if (parentContext) {
      parentContext.__childContexts.push(ctx);
    }
    return ctx;
  },

  getNamedContextOrThrow: function(name) {
    if (this._namedContexts.has(name)) {
      return this._namedContexts.get(name);
    }

    throw new Error('no such namedContext: ' + name);
  },

  maybeGetNamedContext: function(name) {
    return this._namedContexts.get(name);
  },

  cleanupNamedContext: function(name) {
    if (!this._namedContexts.has(name)) {
      return;
    }

    const ctx = this._namedContexts.get(name);
    for (let childContext of ctx.__childContexts) {
      this.cleanupNamedContext(childContext.name);
    }
    this._namedContexts.delete(name);
    ctx.cleanup();
  },

  cleanupAll: function() {
    for (let namedContext of this._namedContext.values()) {
      namedContext.cleanup();
    }
    this._namedContexts.clear();
  }
};

return BridgeContext;
});

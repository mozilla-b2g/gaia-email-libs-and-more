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
        logic(this, 'problem releasing', { what: acquireable, ex: ex });
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
 * - maybe: Composition instances
 */
function BridgeContext(bridge, batchManager) {
  logic.defineScope(this, 'BridgeContext', { name: bridge.name });
  this.bridge = bridge;
  this.batchManager = batchManager;

  this._namedContexts = new Map();
}
BridgeContext.prototype = {
  createNamedContext: function(name, type) {
    let ctx = new NamedContext(name, type, this);
    this._namedContexts.set(name, ctx);
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

    let ctx = this._namedContexts.get(name);
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

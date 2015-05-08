define(function(require) {
'use strict';

let logic = require('../logic');

function NamedContext(name, type, bridgeContext) {
  logic.defineScope(this, type,
                    { name: name, bridge: bridgeContext.bridge.name });
  this.name = name;
  this._bridgeContext = bridgeContext;
  this._active = true;

  this._stuffToRelease = [];
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

  sendMessage: function(type, data) {
    this._bridgeContext.bridge.__sendMessage({
      type: type,
      handles: [this.name],
      data: data
    });
  },

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

    throw new Error('no such namedContext');
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

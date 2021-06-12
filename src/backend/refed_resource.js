define(function(require) {
'use strict';

const co = require('co');
const mix = require('mix');

/**
 * A simple reference-counted resource implementation to be mixed in to
 * implementations that need to be reference counted for resource management
 * reasons.
 */
function RefedResource({ onForgotten }) {
  this._activatePromise = null;
  this._valid = false;
  this._activeConsumers = [];
  this._onForgotten = onForgotten;
}
RefedResource.prototype = {
  /**
   * Asynchronously acquire the resource, to be owned by the given context.
   */
  async __acquire(ctx) {
    if (this._activeConsumers.indexOf(ctx) !== -1) {
      throw new Error('context already refs this resource!');
    }
    this._activeConsumers.push(ctx);
    if (!this._valid && this._activeConsumers.length === 1) {
      // Since the activation is async, it's possible for something else to
      // acquire us while
      this._activatePromise = this.__activate();
      await this._activatePromise;
      this._valid = true;
      this._activatePromise = null;
    } else if (this._activatePromise) {
      await this._activatePromise;
    }
    return this;
  },

  __release: function(ctx) {
    let idx = this._activeConsumers.indexOf(ctx);
    if (idx === -1) {
      throw new Error('context does not ref this resource!');
    }
    this._activeConsumers.splice(idx, 1);

    if (this._activeConsumers.length === 0) {
      this.__deactivate();

      if (this._onForgotten) {
        this._onForgotten(this, this.convId);
      }
      this._onForgotten = null;
    }

    return Promise.resolve();
  }
};

// TODO more rigorous mixin magic
RefedResource.mix = function(obj) {
  Object.keys(RefedResource.prototype).forEach(function(prop) {
    if (obj.hasOwnProperty(prop)) {
      throw new Error('Object already has a property "' + prop + '"');
    }
    obj[prop] = RefedResource.prototype[prop];
  });
  return obj;
};

return RefedResource;
});

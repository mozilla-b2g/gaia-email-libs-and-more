define(function(require) {

let co = require('co');
let mix = require('mix');

/**
 * A simple reference-counted resource implementation to be mixed in to
 * implementations that need to be reference counted for resource management
 * reasons.
 */
function RefedResource() {
  this._activatePromise = null;
  this._valid = false;
  this._activeConsumers = [];
}
RefedResource.prototype = {
  /**
   * Asynchronously acquire the resource, to be owned by the given context.
   */
  __acquire: co.wrap(function*(ctx) {
    if (this._activeConsumers.indexOf(ctx) !== -1) {
      throw new Error('context already refs this resource!');
    }
    this._activeConsumers.push(ctx);
    if (!this._valid && this._activeConsumers.length === 1) {
      // Since the activation is async, it's possible for something else to
      // acquire us while
      this._activatePromise = this.__activate();
      yield this._activatePromise;
      this._valid = true;
      this._activatePromise = null;
    } else if (this._activatePromise) {
      yield this._activatePromise;
    }
    return this;
  }),

  __release: co.wrap(function*(ctx) {
    let idx = this._activeConsumers.indexOf(ctx);
    if (idx === -1) {
      throw new Error('context does not ref this resource!')
    }
    this._activeConsumers.splice(idx, 1);
    // TODO XXX implement cleanup idiom where we tell the context's manager that
    // no one cares about us anymore and we can be deactivate'ed on demand.
  })
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

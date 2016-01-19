define(function(require) {
'use strict';

const evt = require('evt');
const logic = require('logic');
const RefedResource = require('../refed_resource');

/**
 * Base class for TOC implementations.
 *
 * Brought into existence with the introduction of metaHelpers since it marked
 * a turning point in the trade-offs between "code duplication in the name of
 * clarity" and "oh crap, code duplication, this is not going to end well!".
 * (Most of the code was also subtly different for each TOC up to this point.)
 */
function BaseTOC({ metaHelpers }) {
  RefedResource.apply(this, arguments);
  evt.Emitter.call(this);

  this._metaHelpers = metaHelpers || [];

  this.tocMeta = {};
  this._everActivated = false;
}
BaseTOC.prototype = evt.mix(RefedResource.mix({
  __activate: function() {
    this._everActivated = true;
    for (let metaHelper of this._metaHelpers) {
      logic(
        this, 'activatingMetaHelper',
        { name: metaHelper.constructor && metaHelper.constructor.name });
      metaHelper.activate(this);
    }

    return this.__activateTOC.apply(this, arguments);
  },

  __deactivate: function() {
    if (this._everActivated) {
      for (let metaHelper of this._metaHelpers) {
        metaHelper.deactivate(this);
      }
    }

    return this.__deactivateTOC.apply(this, arguments);
  },

  /**
   * A helper that takes a dictionary and applies it to `tocMeta`.  Exists as
   * a central logging point and to have a quick/easy way to do simple diffing
   * to know whether anything is actually changing to avoid emitting events if
   * nothing is changing.  Although there is some performance motivation to
   * this, I expect this to be a larger debugging win because there won't be
   * misleading messages transiting the system that have no effect.
   */
  applyTOCMetaChanges: function(changes) {
    const tocMeta = this.tocMeta;
    let somethingChanged = false;
    for (let key of Object.keys(changes)) {
      let value = changes[key];
      if (tocMeta[key] !== value) {
        tocMeta[key] = value;
        somethingChanged = true;
      }
    }

    if (somethingChanged) {
      this.emit('tocMetaChange', tocMeta);
    }
  },

  /**
   * Emit an event.  The list view proxy should be listening for this,
   * accumulate the event, dirty the proxy, and then send the event as part of
   * its flush.  On the client side this should then be emitted on the list view
   * instance with the provided eventName and eventData.
   */
  broadcastEvent: function(eventName, eventData) {
    this.emit('broadcastEvent', eventName, eventData);
  }
}));

// TODO more rigorous mixin magic
BaseTOC.mix = function(obj) {
  Object.keys(BaseTOC.prototype).forEach(function(prop) {
    if (obj.hasOwnProperty(prop)) {
      throw new Error('Object already has a property "' + prop + '"');
    }
    obj[prop] = BaseTOC.prototype[prop];
  });
  return obj;
};

return BaseTOC;
});

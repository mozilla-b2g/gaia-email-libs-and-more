define(function(require) {
'use strict';

const evt = require('evt');
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

  this._metaHelpers = metaHelpers;

  this.tocMeta = {};
}
BaseTOC.prototype = evt.mix(RefedResource.mix({
  __activate: function() {
    for (let metaHelper of this._metaHelpers) {
      metaHelper.activate(this);
    }

    return this.__activateTOC.apply(this, arguments);
  },

  __deactivate: function() {
    for (let metaHelper of this._metaHelpers) {
      metaHelper.deactivate(this);
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
    for (let key of changes) {
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
   *
   */
  broadcastEvent: function(eventName, eventData) {
    this.emit('broadcast', eventName, eventData);
  }
}));

return BaseTOC;
});

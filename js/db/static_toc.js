define(function(require) {
'use strict';

const logic = require('logic');

const BaseTOC = require('./base_toc');

/**
 * Wraps an unchanging array of items to be used by a WindowedListProxy.
 * No overlay support, no variable height support.  Some form of parametrized
 * reusable TOC is probably in the cards for fancier needs in the future.
 */
function StaticTOC({ items }) {
  BaseTOC.apply(this, arguments);

  logic.defineScope(this, 'StaticTOC');

  this.items = items;

  this.__deactivate(true);
}
StaticTOC.prototype = BaseTOC.mix({
  type: 'StaticTOC',
  overlayNamespace: null,
  heightAware: false,

  __activateTOC: function() {
    return Promise.resolve(this);
  },

  __deactivateTOC: function(/*firstTime*/) {
  },

  get length() {
    return this.items.length;
  },

  get totalHeight() {
    return this.items.length;
  },

  /**
   * Our ordering key is just the index.
   */
  getTopOrderingKey: function() {
    return 0;
  },

  /**
   * Our ordering key is just the index.
   */
  getOrderingKeyForIndex: function(index) {
    return index;
  },

  /**
   * Our ordering key is just the index.
   */
  findIndexForOrderingKey: function(key) {
    return key;
  },

  getDataForSliceRange: function(beginInclusive, endExclusive,
      alreadyKnownData/*, alreadyKnownOverlays*/) {
    beginInclusive = Math.max(0, beginInclusive);
    endExclusive = Math.min(endExclusive, this.items.length);

    // State and overlay data to be sent to our front-end view counterpart.
    // This is (needed) state information we have synchronously available from
    // the db cache and (needed) overlay information (which can always be
    // synchronously derived.)
    let sendState = new Map();
    // The new known set which is the stuff from alreadyKnownData we reused plus
    // the data we were able to provide synchronously.  (And the stuff we have
    // to read from the DB does NOT go in here.)
    let newKnownSet = new Set();

    let items = this.items;
    let ids = [];
    for (let i = beginInclusive; i < endExclusive; i++) {
      let id = i;
      ids.push(id);
      let haveData = alreadyKnownData.has(id);
      if (haveData) {
        newKnownSet.add(id);
        continue;
      }

      newKnownSet.add(id);
      sendState.set(
        id,
        [
          items[i],
          null,
          null
        ]);
    }

    return {
      ids,
      state: sendState,
      pendingReads: null,
      readPromise: null,
      newValidDataSet: newKnownSet
    };
  }
});

return StaticTOC;
});

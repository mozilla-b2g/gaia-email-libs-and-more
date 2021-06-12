import logic from 'logic';

import { bsearchMaybeExists, bsearchForInsert } from 'shared/util';

import { conversationMessageComparator } from './comparators';

import BaseTOC from './base_toc';

/**
 * Represent ordered lists of data that are always memory resident and may
 * dynamically change in order and contents.  Initially created for use by
 * derived views, but could envolve as use-cases arise.  Or more TOC
 * implementations should be created.
 */
export default function DynamicFullTOC({ comparator, idKey, topOrderingKey, onFlush }) {
  BaseTOC.apply(this, arguments);

  logic.defineScope(this, 'DynamicFullTOC');

  this.items = [];
  this._comparator = comparator;
  this._idKey = idKey;
  this._topOrderingKey = topOrderingKey;
  this._onFlush = onFlush;
  // leave the overlay-resolver usage in our copied/pasted code in place.
  this._overlayResolver = () => {};

  this.__deactivate(true);
}
DynamicFullTOC.prototype = BaseTOC.mix({
  type: 'DynamicFullTOC',
  overlayNamespace: null,
  heightAware: false,

  __activateTOC: function() {
    return Promise.resolve();
  },

  __deactivateTOC: function(/*firstTime*/) {
  },

  get length() {
    return this.items.length;
  },

  get totalHeight() {
    return this.items.length;
  },

  addItem: function(item) {
    let newIndex = bsearchForInsert(this.items, item,
                                    this._comparator);
    this.items.splice(newIndex, 0, item);
  },

  updateItem: function(/*item*/) {
  },

  removeItem: function(/*id*/) {
  },

  setItems: function(items) {
    this.items = items.concat();
    // XXX true is currently a temporary hack for us to indicate that we should
    // treat all data as invalidated.
    this.items.sort(this._comparator);
    this.emit('change', true);
  },

  /**
   * Explicitly report dirtying, intended for use by lazy owners that provide
   * an `onFlush` handler.  You do not need to call this if you keep us
   * up-to-date at all times using addItem/updateItem/removeItem.
   */
  reportDirty: function() {
    this.emit('change', null);
  },

  /**
   * Invoked by `WindowedListProxy.flush` as the first thing it does if we
   * reported ourselves as dirty since the last flush.
   */
  flush: function() {
    if (this._onFlush) {
      this._onFlush();
    }
  },

  /**
   * Handle the addition or removal of a message from the TOC.  Note that while
   * we originally tried to stick with the invariant that message dates were
   * immutable, we decided to allow them to change in the case of drafts to
   * allow for simpler conceptual handling.
   *
   * @param {MessageId} change.id
   * @param {DateTS} [preDate]
   *   If the message already existed, its date before the change.  If the
   *   message did not previously exist, this is null.
   * @param {DateTS} [postDate]
   *   If the message has not been deleted, its date after the change.  (Which
   *   should be the same as the date before the change unless the message is a
   *   modified draft.)  If the message has been deleted, this is null.
   * @param {MessageInfo} item
   * @param {Boolean} freshlyAdded
   */
  onTOCChange: function({ id, preDate, postDate, item, freshlyAdded,
                          matchInfo }) {
    let metadataOnly = item && !freshlyAdded;

    if (freshlyAdded) {
      // - Added!
      let newKey = { date: postDate, id, matchInfo };
      let newIndex = bsearchForInsert(this.items, newKey,
                                      conversationMessageComparator);
      this.idsWithDates.splice(newIndex, 0, newKey);
    } else if (!item) {
      // - Deleted!
      let oldKey = { date: preDate, id };
      let oldIndex = bsearchMaybeExists(this.idsWithDates, oldKey,
                                        conversationMessageComparator);
      this.idsWithDates.splice(oldIndex, 1);
    } else if (preDate !== postDate) {
      // - Message date changed (this should only happen for drafts)
      let oldKey = { date: preDate, id };
      let oldIndex = bsearchMaybeExists(this.idsWithDates, oldKey,
                                        conversationMessageComparator);
      this.idsWithDates.splice(oldIndex, 1);

      let newKey = { date: postDate, id, matchInfo };
      let newIndex = bsearchForInsert(this.idsWithDates, newKey,
                                      conversationMessageComparator);
      this.idsWithDates.splice(newIndex, 0, newKey);

      // We're changing the ordering.
      metadataOnly = false;
    }

    this.emit('change', id, metadataOnly);
  },

  /**
   * Return an array of the conversation id's occupying the given indices.
   */
  sliceIds: function(begin, end) {
    const idKey = this._idKey;
    let ids = [];
    const items = this.items;
    for (let i = begin; i < end; i++) {
      ids.push(items[i][idKey]);
    }
    return ids;
  },

  /**
   * Generate an ordering key that is from the distant future, effectively
   * latching us to the top.  We use this for the coordinate-space case where
   * there is nothing loaded yet.
   */
  getTopOrderingKey: function() {
    return this._topOrderingKey;
  },

  getOrderingKeyForIndex: function(index) {
    if (this.items.length === 0) {
      return this.getTopOrderingKey();
    } else if (index < 0) {
      index = 0;
    } else if (index >= this.items.length) {
      index = this.items.length - 1;
    }
    return this.items[index];
  },

  findIndexForOrderingKey: function(key) {
    let index = bsearchForInsert(this.items, key,
                                 this._comparator);
    return index;
  },

  getDataForSliceRange: function(beginInclusive, endExclusive,
      alreadyKnownData, alreadyKnownOverlays) {
    beginInclusive = Math.max(0, beginInclusive);
    endExclusive = Math.min(endExclusive, this.items.length);

    let overlayResolver = this._overlayResolver;

    // State and overlay data to be sent to our front-end view counterpart.
    // This is (needed) state information we have synchronously available from
    // the db cache and (needed) overlay information (which can always be
    // synchronously derived.)
    let sendState = new Map();
    // The new known set which is the stuff from alreadyKnownData we reused plus
    // the data we were able to provide synchronously.  (And the stuff we have
    // to read from the DB does NOT go in here.)
    let newKnownSet = new Set();

    const items = this.items;
    const idKey = this._idKey;
    let ids = [];
    for (let i = beginInclusive; i < endExclusive; i++) {
      let id = items[i][idKey];
      ids.push(id);
      let haveData = alreadyKnownData.has(id);
      let haveOverlays = alreadyKnownOverlays.has(id);
      if (haveData && haveOverlays) {
        newKnownSet.add(id);
        continue;
      }

      if (haveData) {
        // only need overlays
        sendState.set(id, [null, overlayResolver(id)]);
      } else {
        newKnownSet.add(id);
        sendState.set(
          id,
          [
            items[i],
            overlayResolver(id)
          ]);
      }
    }

    return {
      ids: ids,
      state: sendState,
      pendingReads: null,
      readPromise: null,
      newValidDataSet: newKnownSet
    };
  }
});

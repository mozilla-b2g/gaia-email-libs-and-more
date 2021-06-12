import evt from 'evt';

/**
 * @typedef {Object} SeekChangeInfo
 * @property {Boolean} offset
 *   Did the offset change?  If so, you might need to do a coordinate-space
 *   fixup in your virtual list at some point.
 * @property {Boolean} totalCount
 *   Did the total number of items in the true list change?  If so, you might
 *   need to adjust the scroll height of your container.
 * @property {Boolean} itemSet
 *   Were items added/removed/reordered from the items list?  If false, then
 *   for all x, `preItems[x] === postItems[x]`.  Items that were not yet loaded
 *   from the database and therefore null count as a change now that they
 *   properly get an object instance.
 * @property {Boolean} itemContents
 *   Did the contents of some of the items change?  If you care about checking
 *   whether an item's contents changed, you can compare its `serial` with the
 *   WindowedListView's `serial`.  If the values are the same then the item was
 *   updated (or new) in this seek.  If this is inefficient for you, we can add
 *   a list of changed indices or whatever works for you.  Let's discuss.
 */

/**
 * A windowed (subset) view into a conceptually much larger list view.
 *
 * ## Events ##
 * - `seeked` (SeekChangeInfo): Fired when anything happens.  ANYTHING.  This is
 *   the only event you get and you'll like it.  Because the koolaid is
 *   delicious.
 *
 */
export default function WindowedListView(api, itemConstructor, handle) {
  evt.Emitter.call(this);
  this._api = api;
  this.handle = handle;
  this._itemConstructor = itemConstructor;
  this.released = false;

  this.serial = 0;
  this.tocMetaSerial = 0;

  /**
   * The index of `items[0]` in the true entire list.  If this is zero, then we
   * are at the top of the list.
   */
  this.offset = 0;
  this.heightOffset = 0;
  /**
   *
   */
  this.totalCount = 0;
  this.totalHeight = 0;
  /**
   * @type {Array<ItemInstance|null>}
   *
   * The list of items
   */
  this.items = [];
  /**
   * @type {Map<Id, ItemInstance>}
   *
   * Maps id's to non-null object instances.  If we don't have the data yet,
   * then there is no entry in the map.  (This is somewhat arbitrary for
   * control-flow purposes below; feel free to change if you update the control
   * flow.)
   */
  this._itemsById = new Map();

  this.tocMeta = {};

  /**
   * Has this slice been completely initially populated?  If you want to wait
   * for this, use once('complete').
   */
  this.complete = false;
}
WindowedListView.prototype = evt.mix({
  toString: function() {
    return '[WindowedListView: ' + this._itemConstructor.name + ' ' +
           this.handle + ']';
  },
  toJSON: function() {
    return {
      type: 'WindowedListView',
      namespace: this._ns,
      handle: this.handle
    };
  },

  __update: function(details) {
    let newSerial = ++this.serial;

    let existingSet = this._itemsById;
    let newSet = new Map();


    let newIds = details.ids;
    let newStates = details.values;
    let newItems = [];

    // Detect a reduction in set size by a change in length; all other changes
    // will be caught by noticing new objects.
    let itemSetChanged = newIds.length !== this.items.length;
    let contentsChanged = false;

    // - Process our contents
    for (let i = 0; i < newIds.length; i++) {
      let id = newIds[i];
      let obj;
      // Object already known, update.
      if (existingSet.has(id)) {
        obj = existingSet.get(id);
        // Update the object if we have new state
        if (newStates.has(id)) {
          let [newState, newOverlays] = newStates.get(id);
          contentsChanged = true;
          obj.serial = newSerial;
          if (newState) {
            obj.__update(newState);
          }
          if (newOverlays) {
            obj.__updateOverlays(newOverlays);
          }
          obj.emit('change', !!newState, !!newOverlays);
        }
        // Remove it from the existingSet so we can infer objects no longer in
        // the set.
        existingSet.delete(id);
        newSet.set(id, obj);
      } else if (newStates.has(id)) {
        itemSetChanged = true;
        let [newState, newOverlays, matchInfo] = newStates.get(id);
        obj = new this._itemConstructor(
          this._api, newState, newOverlays, matchInfo, this);
        obj.serial = newSerial;
        newSet.set(id, obj);
      } else {
        // No state available yet, push null as a placeholder.
        obj = null;
      }
      newItems.push(obj);
    }

    // - If anything remained, kill it off
    for (let deadObj of existingSet.values()) {
      itemSetChanged = true;
      deadObj.release();
    }

    let whatChanged = {
      offset: details.offset !== this.offset,
      totalCount: details.totalCount !== this.totalCount,
      itemSet: itemSetChanged,
      itemContents: contentsChanged
    };
    this.offset = details.offset;
    this.heightOffset = details.heightOffset;
    this.totalCount = details.totalCount;
    this.totalHeight = details.totalHeight;
    this.items = newItems;
    this._itemsById = newSet;

    if (details.tocMeta) {
      this.tocMeta = details.tocMeta;
      this.tocMetaSerial++;
      this.emit('metaChange', this.tocMeta);
    }

    this.emit('seeked', whatChanged);

    if (details.events) {
      for (let { name, data } of details.events) {
        this.emit(name, data);
      }
    }
  },

  // TODO: determine whether these are useful at all; seems like the virtual
  // scroll widget needs to inherently know these things and these are useless.
  // These come from a pre-absolutely-positioned implementation.
  get atTop() {
    return this.offset === 0;
  },
  get atBottom() {
    return this.totalCount === this.offset + this.items.length;
  },

  /**
   * Return the item by absolute index, returning null if it's outside the
   * currently seeked range.
   *
   * This method does not infer seeks that should happen as a byproduct of gets
   * outside the seeked range.  Your code needs to issue the seek calls itself
   * based on an understanding of the visible item range and the buffering you
   * want.
   */
  getItemByAbsoluteIndex: function(absIndex) {
    let relIndex = absIndex - this.offset;
    if (relIndex < 0 ||
        relIndex >= this.items.length) {
      return null;
    }
    return this.items[relIndex];
  },

  /**
   * Seek to the top of the list and latch there so that our slice will always
   * include the first `numDesired` items in the list.
   */
  seekToTop: function(visibleDesired, bufferDesired) {
    this._api.__bridgeSend({
      type: 'seekProxy',
      handle: this.handle,
      mode: 'top',
      visibleDesired: visibleDesired,
      bufferDesired: bufferDesired
    });
  },

  /**
   * Seek with the intent that we are anchored to a specific item as long as it
   * exists.  If the item ceases to exist, we will automatically re-anchor to
   * one of the adjacent items at the time of its removal.
   *
   * @param {Object} item
   *   The item to focus on.  This must be a current item in `items` or
   *   we will throw.
   */
  seekFocusedOnItem: function(item, bufferAbove, visibleAbove, visibleBelow,
                              bufferBelow) {
    let idx = this.items.indexOf(item);
    if (idx === -1) {
      throw new Error('item is not in list');
    }
    this._api.__bridgeSend({
      type: 'seekProxy',
      handle: this.handle,
      mode: 'focus',
      focusKey: this._makeOrderingKeyFromItem(item),
      bufferAbove: bufferAbove,
      visibleAbove: visibleAbove,
      visibleBelow: visibleBelow,
      bufferBelow: bufferBelow
    });
  },

  /**
   * Seek to an arbitrary absolute index in the list and then anchor on whatever
   * item is at that location.  For UI purposes it makes the most sense to have
   * the index correspond to the first visible message in your list or the
   * central one.
   */
  seekFocusedOnAbsoluteIndex: function(index, bufferAbove, visibleAbove,
                                       visibleBelow, bufferBelow) {
    this._api.__bridgeSend({
      type: 'seekProxy',
      handle: this.handle,
      mode: 'focusIndex',
      index: index,
      bufferAbove: bufferAbove,
      visibleAbove: visibleAbove,
      visibleBelow: visibleBelow,
      bufferBelow: bufferBelow
    });
  },

  /**
   * Seek to the bottom of the list and latch there so that our slice will
   * always include the last `numDesired` items in the list.
   */
  seekToBottom: function(visibleDesired, bufferDesired) {
    this._api.__bridgeSend({
      type: 'seekProxy',
      handle: this.handle,
      mode: 'bottom',
      visibleDesired: visibleDesired,
      bufferDesired: bufferDesired
    });
  },

  /**
   * Given a quantized-height-supporting back-end where every item has an
   * integer height associated with it that creates an arbitrary coordinate
   * space, seek using that coordinate space, latching on the first visible
   * item.
   *
   * IMPORTANT NOTE!  Latching on the item is usually not what you want if you
   * are at the top of the list and you want to see new items as they come in.
   * AKA, if you are seeking to offset 0, you probably want to use `seekToTop`.
   * I'm a bit conflicted about whether we should just be baking this mode of
   * operation into this or support flags/etc. to help you do this.  But for
   * now it's on you.
   *
   * This mode of seeking assumes a virtual list widget with some concept of
   * the visible region and a buffer before it and after it.
   */
  seekInCoordinateSpace: function(offset, before, visible, after) {
    this._api.__bridgeSend({
      type: 'seekProxy',
      handle: this.handle,
      mode: 'coordinates',
      offset: offset,
      before: before,
      visible: visible,
      after: after
    });
  },

  release: function() {
    if (this.released) {
      return;
    }
    this.released = true;

    this._api.__bridgeSend({
        type: 'cleanupContext',
        handle: this.handle
      });

    for (let i = 0; i < this.items.length; i++) {
      let item = this.items[i];
      item.release();
    }
  },
});

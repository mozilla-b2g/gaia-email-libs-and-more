define(function(require) {
'use strict';

var evt = require('evt');

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
 *   for all x, `preItems[x] === postItems[x]`.
 * @property {Boolean} itemContents
 *   Did the contents of some of the items change?  If you care about checking
 *   whether an item's contents changed, you can compare its `serial` with the
 *   WindowedListView's `serial`.  If the values are the same then the item was
 *   updated (or new) in this seek.  If this is inefficient for you, we can add
 *   a list of changed indices or whatever works for you.  Let's discuss.
 */

/**
 * A windowed (subset) view into a conceptually much larger list view.  Because
 * a variety of complicated things can happen
 *
 * ## Events ##
 * - `seeked` (SeekChangeInfo): Fired when anything happens.  ANYTHING.  This is
 *   the only event you get and you'll like it.  Because the koolaid is
 *   delicious.
 *
 */
function WindowedListView(api, ns, handle) {
  evt.Emitter.call(this);
  this._api = api;
  this._ns = ns;
  this._handle = handle;

  this.serial = 0;

  /**
   * The index of `items[0]` in the true entire list.  If this is zero, then we
   * are at the top of the list.
   */
  this.offset = 0;
  /**
   *
   */
  this.totalCount = 0;
  this.items = [];
  this._itemsById = new Map();

  /**
   * Has this slice been completely initially populated?  If you want to wait
   * for this, use once('complete').
   */
  this.complete = false;

}
WindowedListView.prototype = evt.mix({
  toString: function() {
    return '[WindowedListView: ' + this._ns + ' ' + this._handle + ']';
  },
  toJSON: function() {
    return {
      type: 'WindowedListView',
      namespace: this._ns,
      handle: this._handle
    };
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
   * Seek to the top of the list and latch there so that our slice will always
   * include the first `numDesired` items in the list.
   */
  seekToTop: function(numDesired) {
    this._api.__bridgeSend({
      type: 'seekSlice',
      mode: 'top',
      count: numDesired
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
  seekFocusedOnItem: function(item, numAbove, numBelow) {
    let idx = this.items.indexOf(item);
    if (idx === -1) {
      throw new Error('item is not in list')
    }
    this._api.__bridgeSend({
      type: 'seekSlice',
      mode: 'focusItem',
      serial: this.serial,
      itemId: item.id,
      itemIndex: idx,
      above: numAbove,
      below: numBelow
    });
  },

  /**
   * Seek to an arbitrary absolute index in the list and then anchor on whatever
   * item is at that location.  For UI purposes it makes the most sense to have
   * the index correspond to the first visible message in your list or the
   * central one.
   */
  seekFocusedOnIndex: function(index, numAbove, numBelow) {
    this._api.__bridgeSend({
      type: 'seekSlice',
      mode: 'focusIndex',
      index: index,
      above: numAbove,
      below: numBelow
    });

  },

  /**
   * Seek to the bottom of the list and latch there so that our slice will
   * always include the last `numDesired` items in the list.
   */
  seekToBottom: function(numDesired) {
    this._api.__bridgeSend({
      type: 'seekSlice',
      mode: 'bottom',
      count: numDesired
    });
  },

  die: function() {
    // XXX we used to null out our event handlers here; it may be appropriate to
    // do something to ensure that after die() is called no more events are
    // heard from us.  Like re-initing our Emitter or synchronously notifying
    // the API to forget about us or setting some flag, etc.
    this._api.__bridgeSend({
        type: 'killSlice',
        handle: this._handle
      });

    for (var i = 0; i < this.items.length; i++) {
      var item = this.items[i];
      item.__die();
    }
  },
});

return WindowedListView;
});

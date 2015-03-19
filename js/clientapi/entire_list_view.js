define(function(require) {
'use strict';

var evt = require('evt');

/**
 * A view of the entirety of a list view that's stored in the backend.  As the
 * backend changes, you get updates.  Used for cases where the list is small,
 * experiences a low amount of change, and where it would be a hassle to not
 * have information on everything available all the time.  Contrast with
 * WindowedListView.
 *
 * ## Events ##
 * - `add` (item, index)
 * - `change` (item, index)
 * - `remove` (item, index)
 * - `complete`: indicates initial population has completed or some other batch
 *    of changes has completed.  Use `once` if you only care about this being
 *    initialized, or use `on` if you're using something like react.js to do
 *    just conceptually rebuild your UI every time anything changes.
 */
function EntireListView(api, ns, handle) {
  evt.Emitter.call(this);
  this._api = api;
  this._ns = ns;
  this._handle = handle;

  this.serial = 0;

  this.items = [];
  /**
   * Has this slice been completely initially populated?  If you want to wait
   * for this, use once('complete').
   */
  this.complete = false;
}
EntireListView.prototype = evt.mix({
  toString: function() {
    return '[EntireListView: ' + this._ns + ' ' + this._handle + ']';
  },
  toJSON: function() {
    return {
      type: 'EntireListView',
      namespace: this._ns,
      handle: this._handle
    };
  },

  die: function() {
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

return EntireListView;
});

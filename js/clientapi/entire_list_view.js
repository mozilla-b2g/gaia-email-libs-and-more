import evt from 'evt';

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
export default function EntireListView(api, itemConstructor, handle) {
  evt.Emitter.call(this);
  this._api = api;
  this._itemConstructor = itemConstructor;
  this.handle = handle;

  this.serial = 0;

  this.items = [];
  this.itemsById = new Map();

  /**
   * Has this slice been completely initially populated?  Use
   * latestOnce(`complete`, callback) if you want a unified way of waiting for
   * the event while processing ASAP if already available.
   */
  this.complete = false;
}
EntireListView.prototype = evt.mix({
  toString: function() {
    return '[EntireListView: ' + this._ns + ' ' + this.handle + ']';
  },
  toJSON: function() {
    return {
      type: 'EntireListView',
      namespace: this._ns,
      handle: this.handle
    };
  },

  __update: function(details) {
    let newSerial = ++this.serial;

    for (let change of details.changes) {
      if (change.type === 'add') {
        let obj = new this._itemConstructor(
          this._api, change.state, change.overlays, change.matchInfo, this);
        obj.serial = newSerial;
        this.items.splice(change.index, 0, obj);
        this.emit('add', obj, change.index);
      } else if (change.type === 'change') {
        let obj = this.items[change.index];
        obj.serial = newSerial;
        if (change.state) {
          obj.__update(change.state);
        }
        if (change.overlays) {
          obj.__updateOverlays(change.overlays);
        }
        this.emit('change', obj, change.index, !!change.state,
                  !!change.overlays);
        obj.emit('change', !!change.state, !!change.overlays);
      } else if (change.type === 'remove') {
        let obj = this.items[change.index];
        this.items.splice(change.index, 1);
        this.emit('remove', obj, change.index);
      }
    }

    this.complete = true;
    this.emit('complete', this);
  },

  release: function() {
    this._api.__bridgeSend({
        type: 'cleanupContext',
        handle: this.handle
      });

    for (var i = 0; i < this.items.length; i++) {
      var item = this.items[i];
      item.release();
    }
  },
});

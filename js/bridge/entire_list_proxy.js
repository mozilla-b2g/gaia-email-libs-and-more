define(function(require) {
'use strict';

/**
 * Backs an `EntireListView`, see its docs for more context.
 *
 * @param {TOC} toc
 *   An unowned reference to the TOC.  It is expected/required that our caller
 *   has acquired a reference for it and will __release it at the same time
 *   they __release us.
 * @param {BatchManager} batchManager
 *   The batch manager that manages our flushing (once we tell it we are dirty).
 */
function EntireListProxy(toc, ctx) {
  this.toc = toc;
  this.ctx = ctx;
  this.batchManager = ctx.batchManager;

  this._bound_onAdd = this.onAdd.bind(this);
  this._bound_onChange = this.onChange.bind(this);
  this._bound_onRemove = this.onRemove.bind(this);

  this._pendingChanges = [];
  this._idToChangeIndex = new Map();
  // initialize to dirty so that populateFromList can be in charge
  this.dirty = true;
  this._active = false;
}
EntireListProxy.prototype = {
  /**
   * Trigger initial population.  This should be called exactly once at
   * initialization.  This is required to be explicitly called to make things
   * slightly less magic and give the caller some additional control.
   */
  populateFromList: function() {
    let items = this.toc.getAllItems();
    for (let i = 0; i < items.length; i++) {
      this.onAdd(items[i], i);
    }

    this.batchManager.registerDirtyView(this, /* immediate */ true);

    this.toc.on('add', this._bound_onAdd);
    this.toc.on('change', this._bound_onChange);
    this.toc.on('remove', this._bound_onRemove);
  },

  /**
   * Dummy acquire implementation; we only allow a single owner.  We could make
   * this call populateFromList, but for now we don't for clarity.
   */
  __acquire: function() {
    return Promise.resolve(this);
  },

  __release: function() {
    if (!this._active) {
      return;
    }
    this._active = false;

    this.toc.removeListener('add', this._bound_onAdd);
    this.toc.removeListener('change', this._bound_onChange);
    this.toc.removeListener('remove', this._bound_onRemove);
  },

  _dirty: function() {
    if (this.dirty) {
      return;
    }

    this.dirty = true;
    this.batchManager.registerDirtyView(this, /* immediate */ false);
  },

  onAdd: function(item, index) {
    this._dirty();

    this._idToChangeIndex.set(item.id, this._pendingChanges.length);
    this._pendingChanges.push({
      type: 'add',
      index: index,
      state: item
    });
  },

  onChange: function(item, index) {
    // Update the existing add/change to have the updated state rather than
    // adding a change that clobbers the previous state
    if (this._idToChangeIndex.has(item.id)) {
      // (we're already dirty)
      let changeIndex = this._idToChangeIndex.get(item.id);
      this._pendingChanges[changeIndex].state = item;
      return;
    }

    this._dirty();
    this._idToChangeIndex.set(item.id, this._pendingChanges.length);
    this._pendingChanges.push({
      type: 'change',
      index: index,
      state: item
    });
  },

  onRemove: function(id, index) {
    this._dirty();

    this._pendingChanges.push({
      type: 'remove',
      index: index
    });
    this._idToChangeIndex.delete(id);
  },

  flush: function() {
    let changes = this._pendingChanges;
    this._pendingChanges = [];
    this._idToChangeIndex.clear();
    this.dirty = false;

    return {
      changes: changes
    };
  }
};

return EntireListProxy;
});

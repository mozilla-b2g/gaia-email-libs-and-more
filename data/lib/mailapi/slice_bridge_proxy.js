/*global define */
define(
  [
    'exports'
  ],
  function(
    exports
  ) {

function SliceBridgeProxy(bridge, ns, handle) {
  this._bridge = bridge;
  this._ns = ns;
  this._handle = handle;
  this.__listener = null;

  this.status = 'synced';
  this.progress = 0.0;
  this.atTop = false;
  this.atBottom = false;
  /**
   * Can we potentially grow the slice in the negative direction if explicitly
   * desired by the user or UI desires to be up-to-date?  For example,
   * triggering an IMAP sync.
   *
   * This is only really meaningful when `atTop` is true; if we are not at the
   * top then this value will be false.
   *
   * For messages, the implication is that we are not synchronized through 'now'
   * if this value is true (and atTop is true).
   */
  this.userCanGrowUpwards = false;
  this.userCanGrowDownwards = false;
  /**
   *  We batch both slices and updates into the same queue. The MailAPI checks
   *  to differentiate between the two.
   */
  this.pendingUpdates = [];
  this.scheduledUpdate = false;
}

exports.SliceBridgeProxy = SliceBridgeProxy;

SliceBridgeProxy.prototype = {
  /**
   * Issue a splice to add and remove items.
   * @param {number} newEmailCount Number of new emails synced during this
   *     slice request.
   */
  sendSplice: function sbp_sendSplice(index, howMany, addItems, requested,
                                      moreExpected, newEmailCount) {
    var updateSplice = {
      index: index,
      howMany: howMany,
      addItems: addItems,
      requested: requested,
      moreExpected: moreExpected,
      newEmailCount: newEmailCount,
      type: 'slice',
    };
    this.addUpdate(updateSplice);
  },

  /**
   * Issue an update for existing items.
   */
  sendUpdate: function sbp_sendUpdate(indexUpdatesRun) {
    var update = indexUpdatesRun;
    update.type = 'update';
    this.addUpdate(update);
  },

  /**
   * @param {number} newEmailCount Number of new emails synced during this
   *     slice request.
   */
  sendStatus: function sbp_sendStatus(status, requested, moreExpected,
                                      progress, newEmailCount) {
    this.status = status;
    if (progress != null) {
      this.progress = progress;
    }
    this.sendSplice(0, 0, [], requested, moreExpected, newEmailCount);
  },

  sendSyncProgress: function(progress) {
    this.progress = progress;
    this.sendSplice(0, 0, [], true, true);
  },

  addUpdate: function sbp_addUpdate(update) {
    this.pendingUpdates.push(update);
    // If we batched a lot, flush now. Otherwise
    // we sometimes get into a position where nothing happens
    // and then a bunch of updates occur, causing jank
    if (this.pendingUpdates.length > 5) {
      this.flushUpdates();
    } else if (!this.scheduledUpdate) {
      window.setZeroTimeout(this.flushUpdates.bind(this));
      this.scheduledUpdate = true;
    }
  },

  flushUpdates: function sbp_flushUpdates() {
    this._bridge.__sendMessage({
      type: 'batchSlice',
      handle: this._handle,
      status: this.status,
      progress: this.progress,
      atTop: this.atTop,
      atBottom: this.atBottom,
      userCanGrowUpwards: this.userCanGrowUpwards,
      userCanGrowDownwards: this.userCanGrowDownwards,
      sliceUpdates: this.pendingUpdates
    });

    this.pendingUpdates = [];
    this.scheduledUpdate = false;
  },

  die: function sbp_die() {
    if (this.__listener)
      this.__listener.die();
  },
};

});

define(function(require) {
'use strict';

var evt = require('evt');

/**
 * Ordered list collection abstraction where we may potentially only be viewing
 * a subset of the actual items in the collection.  This allows us to handle
 * lists with lots of items as well as lists where we have to retrieve data
 * from a remote server to populate the list.
 */
function BridgedViewSlice(api, ns, handle) {
  evt.Emitter.call(this);
  this._api = api;
  this._ns = ns;
  this._handle = handle;

  this.items = [];

  /**
   * @oneof[
   *   @case['new']{
   *     We were just created and have no meaningful state.
   *   }
   *   @case['synchronizing']{
   *     We are talking to a server to populate/expand the contents of this
   *     list.
   *   }
   *   @case['synced']{
   *     We successfully synchronized with the backing store/server.  If we are
   *     known to be offline and did not attempt to talk to the server, then we
   *     will still have this status.
   *   }
   *   @case['syncfailed']{
   *     We tried to synchronize with the server but failed.
   *   }
   * ]{
   *   Quasi-extensible indicator of whether we are synchronizing or not.  The
   *   idea is that if we are synchronizing, a spinner indicator can be shown
   *   at the end of the list of messages.
   * }
   */
  this.status = 'new';

  /**
   * A value in the range [0.0, 1.0] expressing our synchronization progress.
   */
  this.syncProgress = 0.0;

  /**
   * False if we can grow the slice in the negative direction without
   * requiring user prompting.
   */
  this.atTop = false;
  /**
   * False if we can grow the slice in the positive direction without
   * requiring user prompting.
   */
  this.atBottom = false;

  /**
   * Can we potentially grow the slice in the ngative direction if the user
   * requests it?  For example, triggering an IMAP sync for a part of the
   * time-range we have not previously synchronized.
   *
   * This is only really meaningful when `atTop` is true; if we are not at the
   * top, this value will be false.
   */
  this.userCanGrowUpwards = false;

  /**
   * Can we potentially grow the slice in the positive direction if the user
   * requests it?  For example, triggering an IMAP sync for a part of the
   * time-range we have not previously synchronized.
   *
   * This is only really meaningful when `atBottom` is true; if we are not at
   * the bottom, this value will be false.
   */
  this.userCanGrowDownwards = false;

  /**
   * Number of pending requests to the back-end.  To be used by logic that can
   * defer further requests until existing requests are complete.  For example,
   * infinite scrolling logic would do best to wait for the back-end to service
   * its requests before issuing new ones.
   */
  this.pendingRequestCount = 0;
  /**
   * The direction we are growing, if any (0 if not).
   */
  this._growing = 0;

  this.onadd = null;
  this.onchange = null;
  this.onsplice = null;
  this.onremove = null;
  this.onstatus = null;
  this.oncomplete = null;
  this.ondead = null;
}
BridgedViewSlice.prototype = evt.mix({
  toString: function() {
    return '[BridgedViewSlice: ' + this._ns + ' ' + this._handle + ']';
  },
  toJSON: function() {
    return {
      type: 'BridgedViewSlice',
      namespace: this._ns,
      handle: this._handle
    };
  },

  /**
   * Tell the back-end we no longer need some of the items we know about.  This
   * will manifest as a requested splice at some point in the future, although
   * the back-end may attenuate partially or entirely.
   */
  requestShrinkage: function(firstUsedIndex, lastUsedIndex) {
    this.pendingRequestCount++;
    if (lastUsedIndex >= this.items.length)
      lastUsedIndex = this.items.length - 1;

    // We send indices and suid's.  The indices are used for fast-pathing;
    // if the suid's don't match, a linear search is undertaken.
    this._api.__bridgeSend({
        type: 'shrinkSlice',
        handle: this._handle,
        firstIndex: firstUsedIndex,
        firstSuid: this.items[firstUsedIndex].id,
        lastIndex: lastUsedIndex,
        lastSuid: this.items[lastUsedIndex].id
      });
  },

  /**
   * Request additional data in the given direction, optionally specifying that
   * some potentially costly growth of the data set should be performed.
   */
  requestGrowth: function(dirMagnitude, userRequestsGrowth) {
    if (this._growing)
      throw new Error('Already growing in ' + this._growing + ' dir.');
    this._growing = dirMagnitude;
    this.pendingRequestCount++;

    this._api.__bridgeSend({
        type: 'growSlice',
        dirMagnitude: dirMagnitude,
        userRequestsGrowth: userRequestsGrowth,
        handle: this._handle
      });
  },

  die: function() {
    // Null out all listeners except for the ondead listener.  This avoids
    // the callbacks from having to filter out messages from dead slices.
    this.onadd = null;
    this.onchange = null;
    this.onsplice = null;
    this.onremove = null;
    this.onstatus = null;
    this.oncomplete = null;
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

return BridgedViewSlice;
});

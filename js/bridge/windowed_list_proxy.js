define(function(require) {
'use strict';

/**
 * Works with specific *TOC implementations to provide the smarts to the
 * WindowedListView at the other end of a bridge.  The TOC does all of the hard
 * work like keeping an ordered view of something, listening for changes, and
 * otherwise interacting with the database.
 *
 * Our implementation is almost trivially simple.  We listen for changes from
 * the TOC that affect us and dirty our state (and tell the batch manager we
 * need to be flushed) if anything interesting happens.
 *
 * Almost everything is interesting as far as we're concerned.  Specifically,
 * there are two types of things that can happen:
 * - The ordered list of id's owned by the TOC can change.  (We don't care about
 *   the contents, although changes in contents may be correlated with changes
 *   in ordering.)  We dirty ourselves because this is at the very least very
 *   likely to impact the totalCount and necessitate a flush.
 * - The contents of some stuff in the list changed, but not the ordering.  We
 *   only care about this if the thing that changed was in our list.
 *
 * Our responsibilities are pretty simple:
 * - We convert the front-end's seek request into a stable form.  Right now this
 *   is top, bottom, or focused on a specific point in the ordering key-space.
 *   TODO: In the future the specific point may be adjusted to keep the point
 *   referencing some underlying real item.  That's been the `BrowserContext`
 *   plan but we might as well wait until we implement `BrowserContext` to do
 *   that.
 * - We track what the corresponding view knows about so we can know when it
 *   becomes outdated and to avoid sending redundant information to the view.
 * - We figure out when we are "dirty" in that we need to send some data to the
 *   front-end.  We tell the BatchManager this.
 * - We produce the payload to send over the bridge when `flush` is called by
 *   the BatchManager.  We don't actually know who the bridge is or how to talk
 *   to them.
 * - TODO: Propagate priority information based on what the user can currently
 *   see.  SOME DAY SOON.
 *
 * Key / notable decisions:
 * - It is possible for us to know the id and position of something in the list
 *   and to not have the data immediately available.  We do not wait for the
 *   data to load; we just send what we have now and the view fills in nulls
 *   until we are able to provide it with the data.
 * - Coordination is greatly simplified by us owning the window state.  The
 *   WindowedListView asks for us to seek, but it does not modify its state
 *   AT ALL until we process the request and eventually flush, providing it with
 *   its new state.  This avoids complexities with asynchrony and state
 *   management.  If the view could forget things it thought it didn't care
 *   about, we'd have a major headache in knowing what we have to tell it as it
 *   seeks around.  So it can't.
 *
 * ## Accumulated State ##
 *
 * At all times we know:
 * - viewSet: The id's that the view has valid state for (based on what we told
 *   it.)  As we hear about changes that are in our viewSet, we remove them so
 *   that when we flush we pull the value from the database cache.
 */
function WindowedListProxy(toc, ctx) {
  this.toc = toc;
  this.ctx = ctx;
  this.batchManager = ctx.batchManager;

  this.viewSet = new Set();

  this._bound_onChange = this.onChange.bind(this);
}
WindowedListProxy.prototype = {
  __acquire: function() {
    this.toc.on('change', this._bound_onChange);
    return Promise.resolve(this);
  },

  __release: function() {
    this.toc.removeListener('change', this._bound_onChange);
  },

  seek: function(req) {
    this.numAbove = req.above;
    this.numBelow = req.below;

    if (req.mode === 'top' || req.mode === 'bottom') {
      this.mode = req.mode;
      this.focusKey = null;
    } else if (req.mode === 'focus') {
      this.mode = req.mode;
      this.focusKey = req.focusKey;
    } else if (req.mode === 'focusIndex') {
      this.mode = 'focus';
      this.focusKey = this.toc.getOrderingKeyForIndex(req.index);
    } else {
      throw new Error('bogus seek mode: ' + req.mode);
    }

    this.dirty = true;
    this.batchManager.registerDirtyView(this, /* immediate */ true);
  },

  /**
   * Dirty ourselves if anything happened to the list ordering or if this is an
   * item change for something that's inside our window.
   *
   * NOTE: If/when we implement key stability stuff, it goes here.
   *
   * @param {String} [changeId=null]
   *   For the case where a specific record is now out-of-date and new state for
   *   it needs to be pushed, provide the id.  Note that if the record is not
   *   currently something we have reported, this method call becomes a no-op.
   *   Pass null if an ordering change has occurred.  If both things have
   *   occurred, call us twice!
   */
  onChange: function(id) {
    if (id !== null) {
      // If we haven't told the view about the data, there's no need for us to
      // do anything.  Note that this also covers the case where we have an
      // async read in flight.
      if (!this.viewSet.has(id)) {
        return;
      }
      this.viewSet.delete(id);
    }

    if (this.dirty) {
      return;
    }
    this.dirty = true;
    this.batchManager.registerDirtyView(this, /* immediate */ false);
  },

  /**
   * Synchronously provide the update to be provided to our matching
   * WindowedListView.  If all of the data isn't available synchronously, we
   * will be provided with a Promise for when the data is available, and we'll
   * dirty ourselves again when that promise resolves.  Happily, if things have
   * changed by the time the promise is resolved, it's fine
   */
  flush: function() {
    let beginInclusive, endExclusive;
    if (this.mode === 'top') {
      beginInclusive = 0;
      endExclusive = Math.min(this.toc.length, this.numBelow + 1);
    } else if (this.mode === 'bottom') {
      endExclusive = this.toc.length;
      beginInclusive = Math.max(0, endExclusive - this.numAbove);
    } else if (this.mode === 'focus') {
      let focusIndex = this.toc.findIndexForOrderingKey(this.focusKey);
      beginInclusive = Math.max(0, focusIndex - this.numAbove);
      endExclusive = Math.min(this.toc.length, focusIndex + this.numBelow + 1);
    }

    this.dirty = false;

    let { ids, state, readPromise, newKnownSet } =
      this.toc.getDataforSliceRange(beginInclusive, endExclusive, this.viewSet);

    this.viewSet = newKnownSet;

    if (readPromise) {
      readPromise.then(() => {
        // Trigger an immediate dirtying/flush.
        this.batchManager.registerDirtyView(this, /* immediate */ true);
      });
    }

    return {
      offset: beginInclusive,
      totalCount: this.toc.length,
      ids: ids,
      values: state
    };
  }
};

return WindowedListProxy;
});

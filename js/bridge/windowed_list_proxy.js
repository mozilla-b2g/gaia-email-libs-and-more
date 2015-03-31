define(function(require) {

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
 * - We convert the front-end's seek request into a stable form
 * - We track the window of interest that is a subset of the TOC and the focused
 *   item.  We update these things so that they don't go out of the date.
 * - We accumulate changes for this window as we hear about them, telling our
 *   `BatchManager` that our state has gotten dirty.  But the BatchManager
 *   decides when we should flush.  The goal is that if the back-end is
 *   particularly busy churning for a bit, we insulate the UI and main thread
 *   and its responsiveness from the turnover.
 * - We produce the payload to send over the bridge when `flush` is called.  We
 *   don't actually know who the bridge is or how to talk to them.
 * - We service the seek requests from WindowedListView, updating our state.
 *   (The bridge does know who we are.)
 * - We propagate priority information based on what the user can currently see.
 *   SOME DAY SOON.
 *
 * Key / notable decisions:
 * - It is possible for us to know the id and position of something in the list
 *   and to not have the data immediately available.  We provide null payload
 *   values for things that we're still loading.  We will eventually fill them
 *   in with data or the items will be removed.  The alternative would be for
 *   us to refuse to flush when are missing some data, but that can lead to
 *   the potential for pathological starvation especially if anything ever
 *   glitches.  So we just provide nulls and it's up to the consumer to
 *   competently use placeholder items, etc.
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
function WindowedListProxy(toc, batchManager) {
  this.toc = toc;
  this.batchManager = batchManager;

  this.viewSet = new Set();

  this._bound_onChange = this.onChange.bind(this);
}
WindowedListProxy.prototype = {
  __acquire: function() {
    this.toc.on('change', this._bound_onChange);
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
      throw new Error('bogus seek mode: ' + req.mode)
    }

    this.dirty = true;
    this.batchManager.registerDirtyView(this, /* immediate */ true);
  },

  /**
   * Dirty ourselves if anything happened to the list ordering or if this is an
   * item change for something that's inside our window.
   */
  onChange: function(changeRec) {
    this.viewSet.delete(changeRec.id);

    if (this.dirty) {
      return;
    }
    this.dirty = true;
    this.batchManager.registerDirtyView(this, /* immediate */ false);
  },

  /**
   * Generate a seek update
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

    let { ids, state, pendingReads, readPromise } =
      this.toc.getDataforSliceRange(beginInclusive, endExclusive, this.viewSet);

    

    return {
      offset: beginInclusive,
      totalCount: this.toc.length,
      ids: [],
      values: set
    };
  }
};

return WindowedListProxy;
});

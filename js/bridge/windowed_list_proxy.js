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
 *   it.)
 *
 * From the first instant our state is dirtied and until we are flushed, we
 * track/retain:
 * - liveMap: The current set of ids that fall in our window and their state, if
 *   we have it because it was recently updated.  If we don't have a more
 *   up-to-date state but it is in `viewSet`, the value is true.  If we don't
 *   have the state and the view doesn't know and we probably need to load it,
 *   we put null in.
 *
 * The failure mode for all of this is the case of something like the list of
 * conversation info data where the sync process could potentially cause a
 * sustained interval of shuffling where items may come into our
 * (non-top-anchored window) then jump out then shift back down into our window
 * but now the data is gone.  We could maintain a `spillMap` or something, but
 * then we need to bound it or whatever and it's at least way too complicating
 * to implement now.  If it becomes an issue, having the database centrally
 * handle caching and having us able to synchronously consult the cache during
 * our flush is probably the best architectural choice.
 */
function WindowedListProxy(toc, batchManager) {
  this.toc = toc;
  this.batchManager = batchManager;

  this.viewSet = new Set();
  this.liveMap = new Map();
}
WindowedListProxy.prototype = {
  seek: function(req) {
    if (req.mode === 'top')

    this.focusType = focusType;
    this.focusOn = focusOn;
    this.numAbove = numAbove;
    this.numBelow = numBelow;
    this.dirty = false;

    this.batchManager.registerDirtyView(this, /* immediate */ true);
  },

  /**
   * Dirty ourselves if anything happened to the list ordering or if this is an
   * item change for something that's inside our window.
   */
  onChange: function(changeRec) {
    if (this.dirty) {
      return;
    }
    this.dirty = true;
    this.batchManager.registerDirtyView(this, /* immediate */ false);
  },

  /**
   * Generate
   */
  flush: function() {
    if (this.mode === 'top') {
      
    } else if (this.mode === 'bottom') {

    }



    return {
      offset: 0,
      totalCount: 0,
      ids: [],
      values: set
    };
  }
};

return WindowedListProxy;
});

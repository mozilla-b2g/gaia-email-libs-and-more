define(function() {
'use strict';

/**
 * Listens to sync_refresh/sync_grow task lifecycles and toc change events.
 * The provided events and tocMeta fields are described for consumer perspective
 * on `ConversationsListView`, but we enumerate them and describe any
 * implementation complexities here.
 *
 * @param {AccountInfo|FolderInfo} [arg.syncStampSource]
 *   The object to pull lastSuccessfulSyncAt and lastAttemptedSyncAt off of.
 *
 * ## Events ##
 * - syncComplete: We track this by listening for overlay changes about the
 *   folder in question.
 *
 * ## tocMeta fields ##
 * Note that all of our fields from data objects are sampled at overlay change
 * time as opposed to us listening to the database for changes on the folder or
 * account directly.  This is done for a few reasons:
 * - The sync timestamps only change when a sync completes and we already know
 *   that we'll get an overlay change in these cases, so listening to the db
 *   is arguably wasteful.
 * - The sync timestamps on the folder/account are actually somewhat misleading
 *   because they update when the sync_refresh/sync_grow task completes rather
 *   than when their task group completes.  We are able to be more clever and
 *   improve the UX for consumers by only sampling on the sync falling edge.
 *   (Because overlay invalidations are synchronous and we consume them
 *   synchronously, this means there is no potential for races that confuse us
 *   here.)
 *
 * Fields from data objects, sampled at falling edge of syncStatus only:
 * - lastSuccessfulSyncAt {DateMS}
 * - lastAttemptedSyncAt {DateMS}
 * Fields from overlays:
 * - syncStatus {String}
 * - syncBlocked {String}
 */
function SyncLifecycle({ folderId, syncStampSource, dataOverlayManager }) {
  this.folderId = folderId;
  this.syncStampSource = syncStampSource;
  /**
   * This index at which a conversation must be inserted/updated at in order to
   * count as newish.  As we hear about things being inserted at/above this
   * point we increment it because the region containing newish things is
   * growing.  (Newish things will show up effectively randomly from our
   * perspective.)
   *
   * We brand this as 'exclusive' because the item at this index value is not
   * newish.  The most complicated edge-case we have is if the item at the 0th
   * position moves from 0th position to 0th position.  (Without checking the
   * date this is ambiguous.  For now we just assume it's getting newer because
   * I'm okay with us being slightly misleading in this one case to avoid some
   * code complexity.)  In that case, newishIndexExclusive will end up 1 after
   * the onIndexChange call.
   *
   * Reset back to zero when we generate a 'syncComplete' broadcast event.
   */
  this.newishIndexExclusive = 0;

  this.toc = null;
  this.firstTime = true;
  this.syncActive = false;

  this.dataOverlayManager = dataOverlayManager;
  this.resolveFolderOverlay = dataOverlayManager.makeBoundResolver('folders');

  this._bound_onIndexChange = this.onIndexChange.bind(this);
  this._bound_onOverlayChange = this.onOverlayChange.bind(this);
}
SyncLifecycle.prototype = {
  constructor: SyncLifecycle,
  activate: function(toc) {
    this.toc = toc;
    this.newIndex = 0;
    this.toc.on('_indexChange', this._bound_onIndexChange);
    this.dataOverlayManager.on('folders', this._bound_onOverlayChange);

    // Force the toc meta to update immediately.  also ensure a falling edge
    // is impossible by flagging sync as previously not active.
    this.firstTime = true;
    this.syncActive = false;
    this.onOverlayChange(this.folderId);
  },

  deactivate: function() {
    this.toc.removeListener('_indexChange', this._bound_onIndexChange);
    this.dataOverlayManager.removeListener(
      'folders', this._bound_onOverlayChange);
  },

  onIndexChange: function(oldIndex, newIndex) {
    if (newIndex === -1) {
      // This was a deletion, we may need to decrease the newishIndex.
      // (oldIndex can't be -1 too.)
      if (oldIndex < this.newishIndexExclusive) {
        this.newishIndexExclusive--;
      }
      // else: we don't care.  it was outside the newish range.
    } else {
      if (newIndex <= this.newishIndexExclusive) {
        // It may be new!  It's in the range!  It's newish if:
        // * there was no old index
        // * the old index was not already in the range.  (Yes, we're testing
        //   for equality on both sides because insertion is displacing and the
        //   newIndex is post-displacement, so it's effectively dealing with
        //   newishIndexInclusive!)
        if (oldIndex === -1 || oldIndex >= this.newishIndexExclusive) {
          this.newishIndexExclusive++;
        }
        // else: it was already newish!
      }
    }
  },

  onOverlayChange: function(changedFolderId) {
    // we get a namespace firehose right now, so we must filter down to our id.
    if (changedFolderId !== this.folderId) {
      return;
    }

    let overlays = this.resolveFolderOverlay(changedFolderId);
    let syncOverlay =
      overlays ? (overlays.sync_refresh || overlays.sync_grow || {}) : {};

    // We don't need to do diffing to avoid being too chatty;
    // applyTOCMetaChanges does that for us.
    const reviseMeta = {};
    reviseMeta.syncStatus = syncOverlay.status || null;
    reviseMeta.syncBlocked = syncOverlay.blocked || null;

    let newSyncActive = !!syncOverlay.status;
    // If this is a falling edge, then we want to sample the timestamps and emit
    // an event.  Alternately, if it's our first time, we want to sample the
    // timestamps but not an event.  (So we check syncFinished again inside
    // the method.  This was a late-change, this control flow could be slightly
    // cleaned up.)
    let syncFinished = this.syncActive && !newSyncActive;
    if (syncFinished || this.firstTime) {
      this.firstTime = false;
      // The account has a syncInfo object clobbered onto it in its entirety,
      // so we can't just have syncStampSource directly point at syncInfo when
      // we are initialized.
      const syncStampSource = this.syncStampSource.syncInfo ||
                              this.syncStampSource;
      reviseMeta.lastSuccessfulSyncAt = syncStampSource.lastSuccessfulSyncAt;
      reviseMeta.lastAttemptedSyncAt = syncStampSource.lastAttemptedSyncAt;

      this.toc.applyTOCMetaChanges(reviseMeta);
      if (syncFinished) {
        this.toc.broadcastEvent(
          'syncComplete',
          {
            // It just so happens that an exclusive index value like this is
            // also a count!  (Using "count" seemed more ambiguous/confusing to
            // me.)
            newishCount: this.newishIndexExclusive
          }
        );
        this.newishIndexExclusive = 0;
      }
    } else {
      // It wasn't a falling edge.  It's possible nothing changed for us, even.
      // But still, let's dirty the tocMeta
      this.toc.applyTOCMetaChanges(reviseMeta);
    }
    this.syncActive = newSyncActive;
  }
};

return SyncLifecycle;
});

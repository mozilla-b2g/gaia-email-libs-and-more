import logic from 'logic';
import { encodeInt } from 'shared/a64';

/**
 * POP3 sync state.
 *
 * Our persisted state consists of:
 * - uidlToUmid: Maps UIDLs to umid's for synchronized messages (including
 *   messages for which we've generated a sync_message task).
 * - deletedUidls: UIDLs for messages that we've locally deleted and we need to
 *   remember so that we don't think the message is a new message.
 * - overflowUidlsToSize: The set of UIDLs for which we have not tried to
 *   synchronize, but will when the user triggers a sync_grow task.  We stash
 *   the size information because we have it and I guess we could use it for
 *   decision making.  (I feel bad about us calling LIST.)
 */
function SyncStateHelper(ctx, rawSyncState, accountId, mode, maxNewMessages) {
  if (!rawSyncState) {
    logic(ctx, 'creatingDefaultSyncState', {});
    rawSyncState = {
      nextUmidSuffix: 1,
      uidlToUmid: new Map(),
      deletedUidls: new Set(),
      overflowUidlsToSize: new Map()
    };
  }

  this._ctx = ctx;
  this._accountId = accountId;
  this.rawSyncState = rawSyncState;
  this._growMode = mode === 'grow';

  this._uidlToUmid = rawSyncState.uidlToUmid;
  this._deletedUidls = rawSyncState.deletedUidls;
  this._overflowUidlsToSize = rawSyncState.overflowUidlsToSize;

  this.maxNewMessages = maxNewMessages;

  // The set of umids that have been deleted.
  this.umidDeletions = new Set();
  // Map from umid to new flags
  this.umidFlagChanges = new Map();
  // The umidName reads to issue, merged from umidDeletions and umidFlagChanges
  this.umidNameReads = new Map();

  // A running list of tasks to spin-off
  this._tasksByConvId = new Map();
  this.tasksToSchedule = [];
  this.umidNameWrites = new Map();
  this.umidLocationWrites = new Map();
}
SyncStateHelper.prototype = {
  get lastHighUid() {
    return this.rawSyncState.lastHighUid;
  },

  set lastHighUid(val) {
    this.rawSyncState.lastHighUid = val;
  },

  get sinceDate() {
    return this.rawSyncState.sinceDate;
  },

  set sinceDate(val) {
    this.rawSyncState.sinceDate = val;
  },

  issueUniqueMessageId: function() {
    return (this._accountId + '.' +
            encodeInt(this.rawSyncState.nextUmidSuffix++));
  },

  /**
   * Given the list of all the uidls (and their sizes) in the maildrop, do delta
   * inference to figure out what's new, known, deleted, etc.  We call out to
   * our other helpers as we discover these things.
   *
   * This method has more sync logic in it than I really want, but I don't want
   * to expose the rep of our various maps/etc. and wrapping them to move this
   * logic out would bloat the logic for little gain.  (By definition, the
   * JIT is going to have less risk of trouble with this one consolidated
   * function.  Do consider splitting out as needed.)
   */
  deltaCheckUidls: function(allMessages) {
    let uidlToUmid = this._uidlToUmid;
    let deletedUidls = this._deletedUidls;
    let overflowUidlsToSize = this._overflowUidlsToSize;

    // Build sets so that we can infer UIDLs that we know about that the server
    // no longer knows/cares about.  We do not do this to emit deletions since
    // it's possible the POP3 server just has a finite sync or storage horizon.
    // This is strictly about removing useless information from our state.
    let unseenSynced = new Set(uidlToUmid.keys());
    let unseenDeleted = new Set(deletedUidls);
    let unseenOverflow = new Set(overflowUidlsToSize.keys());

    let newMessageBudget = this.maxNewMessages;

    for (let { uidl, size } of allMessages) { // uidl, size, number
      if (uidlToUmid.has(uidl)) {
        // already known/synchronized message, nothing to do.
        unseenSynced.delete(uidl);
        continue;
      } else if (deletedUidls.has(uidl)) {
        // already known to be deleted message, nothing to do.
        unseenDeleted.delete(uidl);
        continue;
      } else if (overflowUidlsToSize.has(uidl)) {
        // already tracked as overflow, nothing to do there.
        unseenOverflow.delete(uidl);
        continue;
      }

      // - It's new to us!
      // Should we treat it as new?
      if (newMessageBudget > 0) {
        newMessageBudget--;
        this.newMessageToSync(uidl, size);
      }
      // Eh, I guess it's overflow!
      else {
        this.newOverflowMessage(uidl, size);
      }
    }

    // -- State Cleanout
    // synchronized messages are more complicated, use a helper.
    this.cleanupUnseenSyncedMessages(unseenSynced);
    // for the others, we just don't want them cluttering up our maps anymore.
    for (let uidl of unseenDeleted) {
      deletedUidls.delete(uidl);
    }
    for (let uidl of unseenOverflow) {
      overflowUidlsToSize.delete(uidl);
    }
  },

  /**
   * We've got a new message we've decided to synchronize.  Hooray!  Update our
   * sync structures and generate a sync_message task to actually synchronize
   * it.
   */
  newMessageToSync: function(uidl, size) {
    let umid = this.issueUniqueMessageId();
    this.umidLocationWrites.set(umid, uidl);
    this._makeMessageTask(uidl, umid, size);
    this._uidlToUmid.set(uidl, umid);
  },

  /**
   * Track a message as living in overflow for future synchronizing.
   */
  newOverflowMessage: function(uidl, size) {
    this._overflowUidlsToSize.set(uidl, size);
  },

  /**
   * Given a set of UIDLs we have synchronized and that remain synchronized but
   * no longer exist on the server, clean up our awareness of the UIDL and our
   * umid mappings which cease to have a purpose.
   */
  cleanupUnseenSyncedMessages: function(unseenSynced) {
    for (let uidl of unseenSynced) {
      let umid = this._uidlToUmid.get(uidl);
      this._uidlToUmid.delete(uidl);
      this.umidNameWrites.set(umid, null);
      this.umidLocationWrites.set(umid, null);
    }
  },

  /**
   * Take `count` messages from the overflow bucket and sync them like they were
   * new and not overflow.
   *
   * TODO: recency awareness heuristic.
   */
  syncOverflowMessages: function(count) {
    let uidlsToSync =
      Array.from(this._overflowUidlsToSize.keys()).slice(0, count);
    for (let uidl of uidlsToSync) {
      this._overflowUidlsToSize.delete(uidl);
      this.newMessageToSync(uidl);
    }
  },

  /**
   * Move a message from the locally-synced bucket to the we-deleted-it bucket,
   * clearing out the umidLocation entry as well.  Practically speaking, this
   * is overkill from a correct operation perspective.  But from a testing
   * perspective and if anyone ever tries to improve our POP3 implementation,
   * it is a helpful nuance.
   */
  deletingMessage: function(uidl) {
    // XXX implement when we implement deletion.
  },

  getUmidForUidl: function(uidl) {
    return this._uidlToUmid.get(uidl);
  },

  /**
   * Given the search results of searching for all known UIDs, figure out which
   * UIDs, if any, disappeared, and make a note for a umid-lookup pass so we
   * can subsequently generate aggregate tasks for sync_conv.
   */
  inferDeletionFromExistingUids: function(newUids) {
    let uidsNotFound = new Set(this._uidInfo.keys());
    for (let uid of newUids) {
      uidsNotFound.delete(uid);
    }

    let { _uidInfo: uidInfo, umidDeletions, umidNameReads,
          umidLocationWrites } = this;
    for (let uid of uidsNotFound) {
      let { umid } = uidInfo.get(uid);
      uidInfo.delete(uid);
      umidDeletions.add(umid);
      umidNameReads.set(umid, null);

      // Nuke the umid location record.  The sync_conv job will take care of the
      // umidName for consistency reasons.
      umidLocationWrites.set(umid, null);
    }
  },

  /**
   * Create a sync_message task for a newly added message.
   */
  _makeMessageTask: function(uidl, umid, size) {
    let task = {
      type: 'sync_message',
      accountId: this._accountId,
      uidl,
      umid,
      size
    };
    this.tasksToSchedule.push(task);
    return task;
  }
};

export default SyncStateHelper;

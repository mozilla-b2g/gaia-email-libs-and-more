import logic from 'logic';

import { convIdFromMessageId } from 'shared/id_conversions';

import { encodeInt } from 'shared/a64';

/**
 * Vanilla IMAP helper logic for folder sync state manipulation.
 *
 * Our sync state contains:
 *
 * - nextUmidSuffix: We allocate unique umid's by prefixing them with our
 *   folderId, and this is the one-up counter that drives that.
 * - sinceDate: The date for our active sync range.  This only matters for the
 *   grow step.  It is *not* used for deletion inference.  (Because we support
 *   having synchronized messages outside the sinceDate range due to
 *   conversation backfill or search results.)
 * - lastHighUid: The highest UID we know about for the folder, used for
 *   detecting new messages that may be of interest to us.  The first time we
 *   sync a folder, this is UIDNEXT-1 if UIDNEXT is available or just the
 *   highest UID we saw from our SEARCH results if not.  Subsequently, it's just
 *   the highest UID we've heard about from our new message checking.
 * - flagSets: A list of JSON.stringify'ed sorted flag sets used so we can
 *   characterize a message's flags by an index into this list.
 * - flagSetCounts: A parallel list to flagSets where each value is the count of
 *   messages using that flag-set.
 * - uidInfo: A map from message UID to the { umid, flagSlot }.
 */
export default function FolderSyncStateHelper(ctx, rawSyncState, accountId, folderId, mode) {
  if (!rawSyncState) {
    logic(ctx, 'creatingDefaultSyncState', {});
    rawSyncState = {
      nextUmidSuffix: 1,
      sinceDate: 0,
      lastHighUid: 0,
      flagSets: [],
      flagSetCounts: [],
      uidInfo: new Map()
    };
  }

  this._ctx = ctx;
  this._accountId = accountId;
  this._folderId = folderId;
  this.rawSyncState = rawSyncState;
  this._growMode = mode === 'grow';

  this._flagSets = this.rawSyncState.flagSets;
  this._flagSetCounts = this.rawSyncState.flagSetCounts;
  this._uidInfo = this.rawSyncState.uidInfo;

  // The set of umids that have been deleted.
  this.umidDeletions = new Set();
  // Map from umid to new flags
  this.umidFlagChanges = new Map();
  // The umidName reads to issue, merged from umidDeletions and umidFlagChanges
  this.umidNameReads = new Map();

  // A running list of tasks to spin-off
  this._tasksByConvId = new Map();
  this.tasksToSchedule = [];
  this.umidLocationWrites = new Map();
}
FolderSyncStateHelper.prototype = {
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

  get knownMessageCount() {
    return this._uidInfo.size;
  },

  issueUniqueMessageId: function() {
    return (this._folderId + '.' +
            encodeInt(this.rawSyncState.nextUmidSuffix++));
  },

  /**
   * Normalize the list of flags and find the flag slot this entry corresponds
   * to.  This will allocate a flag slot if one does not already exist.  In no
   * event will we manipulate _flagSetCounts.  You do that!
   */
  _findFlagSlot: function(flags) {
    flags.sort();
    let normStr = JSON.stringify(flags);
    let idx = this._flagSets.indexOf(normStr);
    if (idx === -1) {
      idx = this._allocateFlagSlot(normStr);
    }
    return idx;
  },

  /**
   * Allocate a flag slot for the given normalized flag string.  Helper for use
   * by _findFlagSlot only.
   */
  _allocateFlagSlot: function(normStr) {
    let idx = this._flagSets.indexOf(null);
    if (idx === -1) {
      idx = this._flagSets.length;
      this._flagSets.push(normStr);
      this._flagSetCounts.push(0);
    }
    return idx;
  },

  _incrFlagSlot: function(slot) {
    this._flagSetCounts[slot]++;
  },

  _decrFlagSlot: function(slot) {
    let newVal = --this._flagSetCounts[slot];
    if (newVal === 0) {
      this._flagSets[slot] = null;
    }
    if (newVal < 0) {
      logic.fail('flag slot reference count variant violation');
    }
  },

  isKnownUid: function(uid) {
    return this._uidInfo.has(uid);
  },

  /**
   * Given a list of uids, filter out the UIDs we already know about.
   */
  filterOutKnownUids: function(uids) {
    return uids.filter((uid) => {
      return !this._uidInfo.has(uid);
    });
  },

  /**
   * Return a list of all UIDs known to us.
   */
  getAllUids: function() {
    return Array.from(this._uidInfo.keys());
  },

  getUmidForUid: function(uid) {
    let info = this._uidInfo.get(uid);
    if (info) {
      return info.umid;
    } else {
      return null;
    }
  },

  /**
   * Does this message meet our date sync criteria?
   */
  messageMeetsSyncCriteria: function(date) {
    return date >= this.sinceDate;
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
   * A search by date revealed this UID and we've already run filterOutKnownUids
   * before deciding to fetch the flags, so it's a sure thing that we want to
   * track this message and it's not already known.
   */
  yayMessageFoundByDate: function(uid, dateTS, flags) {
    let flagSlot = this._findFlagSlot(flags);
    this._incrFlagSlot(flagSlot);

    let umid = this.issueUniqueMessageId();
    this.umidLocationWrites.set(umid, [this._folderId, uid]);
    this._makeMessageTask(uid, umid, dateTS, flags);
    this._uidInfo.set(uid, { umid, flagSlot });
  },

  /**
   * Check if the flags for a message have changed.  If so, update our record of
   * the flags and make a note of the umid so we can later resolve it to its
   * conversation and enqueue a sync_conv task.
   */
  checkFlagChanges: function(uid, flags) {
    let info = this._uidInfo.get(uid);
    let oldFlagSlot = info.flagSlot;
    let newFlagSlot = this._findFlagSlot(flags);
    if (newFlagSlot !== oldFlagSlot) {
      this._decrFlagSlot(oldFlagSlot);
      this._incrFlagSlot(newFlagSlot);
      info.flagSlot = newFlagSlot;
      this.umidFlagChanges.set(info.umid, flags);
      this.umidNameReads.set(info.umid, null);
    }
  },

  /**
   * Now that the umidNameReads should have been satisfied, group all flag
   * changes and deletions by conversation
   */
  generateSyncConvTasks: function() {
    let umidNameReads = this.umidNameReads;
    for (let [umid, flags] of this.umidFlagChanges) {
      let messageId = umidNameReads.get(umid);
      if (messageId) {
        this._ensureTaskWithUmidFlags(messageId, umid, flags);
      }
    }
    for (let umid of this.umidDeletions) {
      let messageId = umidNameReads.get(umid);
      if (messageId) {
        this._ensureTaskWithRemovedUmid(messageId, umid);
      }
    }
  },

  _ensureTaskWithUmidFlags: function(messageId, umid, flags) {
    let convId = convIdFromMessageId(messageId);
    let task = this._ensureConvTask(convId);
    if (!task.modifiedUmids) {
      task.modifiedUmids = new Map();
    }
    task.modifiedUmids.set(umid, flags);
  },

  _ensureTaskWithRemovedUmid: function(messageId, umid) {
    let convId = convIdFromMessageId(messageId);
    let task = this._ensureConvTask(convId);
    if (!task.removedUmids) {
      task.removedUmids = new Set();
    }
    task.removedUmids.add(umid);
  },

  /**
   * Create a sync_message task for a newly added message.
   */
  _makeMessageTask: function(uid, umid, dateTS, flags) {
    let task = {
      type: 'sync_message',
      accountId: this._accountId,
      folderId: this._folderId,
      uid,
      umid,
      dateTS,
      flags
    };
    this.tasksToSchedule.push(task);
    return task;
  },

  _ensureConvTask: function(convId) {
    if (this._tasksByConvId.has(convId)) {
      return this._tasksByConvId.get(convId);
    }

    let task = {
      type: 'sync_conv',
      accountId: this._accountId,
      convId,
      modifiedUmids: null, // Map<UniqueMessageId, Flags>
      removedUmids: null // Set<UniqueMessageId>
    };
    this.tasksToSchedule.push(task);
    this._tasksByConvId.set(convId, task);
    return task;
  }
};

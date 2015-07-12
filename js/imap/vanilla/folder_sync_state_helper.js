define(function(require) {
'use strict';

let logic = require('../logic');

let a64 = require('../a64');

/**
 * Vanilla IMAP helper logic for sync state manipulation.
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
 * - uidInfo: A map from message UID to the { umid, flagSet }.
 */
function FolderSyncStateHelper(ctx, rawSyncState, accountId, folderId, mode) {
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

  // A running list of tasks to spin-off
  this.tasksToSchedule = [];
  this.umidNameWrites = new Map();
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

  issueUniqueMessageId: function() {
    return (this._folderId + '.' +
            a64.encodeInt(this.rawSyncState.nextUmidSuffix++));
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

  /**
   * Given a list of uids, filter out the UIDs we already know about.
   */
  filterOutKnownUids: function(uids) {
    return uids.filter((uid) => {
      return !this._uidInfo.has(uid);
    });
  },

  /**
   * Does this message meet our date sync criteria?
   */
  messageMeetsSyncCriteria: function(date) {
    return date >= this.sinceDate;
  },

  /**
   * A search by date revealed this UID and we've already run filterOutKnownUids
   * before deciding to fetch the flags, so it's a sure thing that we want to
   * track this message and it's not already known.
   */
  yayMessageFoundByDate: function(uid, dateTS, flags) {
    let flagIdx = this._findFlagSlot(flags);
    this._incrFlagSlot(flagIdx);

    let umid = this.issueUniqueMessageId();
    this.umidNameWrites.set(umid, null);
    this.umidLocationWrites.set(umid, [this._folderId, uid]);
    this._makeMessageTask(uid, umid, dateTS, flags);
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

  _updateTaskWithNewUid: function(stash, uid, rawConvId, dateTS) {
    // If we're in grow mode, we don't need to update state for the UIDs and so
    // we don't need to generate a task.
    if (this._growMode) {
      return;
    }
    if (!stash.task) {
      stash.task = this._makeConvTask(rawConvId);
    }
    let task = stash.task;
    if (!task.newConv) { // (don't specify uid's if it's a new conversation)
      if (!task.newUids) {
        task.newUids = new Set();
      }
      task.newUids.add(uid);
    }
    if (dateTS > stash.mostRecent) {
      stash.mostRecent = dateTS;
      task.mostRecent = dateTS;
    }
  },

  _updateTaskWithModifiedUid: function(stash, uid, rawConvId, newState) {
    if (!stash.task) {
      stash.task = this._makeConvTask(rawConvId);
    }
    let task = stash.task;
    if (!task.newConv) { // (don't specify uid's if it's a new conversation)
      if (!task.modifiedUids) {
        task.modifiedUids = new Map();
      }
      task.modifiedUids.set(uid, newState);
    }
  },

  _updateTaskWithRemoveUid: function(stash, uid, rawConvId, dateTS) {
    if (!stash.task) {
      stash.task = this._makeConvTask(rawConvId);
    }
    let task = stash.task;
    if (!task.newConv) { // (don't specify uid's if it's a new conversation)
      if (!task.removedUids) {
        task.removedUids = new Set();
      }
      task.removedUids.add(uid);
    }
  },

  _updateForRemoval: function(stash) {
    stash.task.removeConv = true;
    // note: it's impossible for newConv to be true at this point since we
    // should only hear about each message once and newConv being true means
    // we've put a uid in yayUids and so we can't be removing it during this
    // sync "round".
    this._stashesPendingForRemoval.add(stash);
  },

  _updateSavedFromRemoval: function(stash) {
    stash.task.removeConv = false;
    this._stashesPendingForRemoval.delete(stash);
  },

  isKnownRawConvId: function(rawConvId) {
    return this.rawConvIdToConvStash.has(rawConvId);
  },

  /**
   * It's a new message that meets our sync criteria and it's the first message
   * we've heard of in this conversation, so it's a new conversation!
   */
  newYayMessageInNewConv: function(uid, rawConvId, dateTS) {
    this.metricUseful++;
    this.yayUids.set(uid, rawConvId);
    let stash = {
      rawConvId: rawConvId,
      yayUids: [uid],
      mehUids: [],
      mostRecent: dateTS,
      task: this._makeConvTask(rawConvId)
    };
    this.rawConvIdToConvStash.set(rawConvId, stash);

    stash.task.newConv = true;
    stash.task.mostRecent = dateTS;
  },

  newYayMessageInExistingConv: function(uid, rawConvId, dateTS) {
    this.metricUseful++;
    this.yayUids.set(uid, rawConvId);
    let stash = this.rawConvIdToConvStash.get(rawConvId);
    stash.yayUids.push(uid);
    this._updateTaskWithNewUid(stash, uid, rawConvId, dateTS);
  },

  newMehMessageInExistingConv: function(uid, rawConvId, dateTS) {
    this.metricUseful++;
    this.mehUids.set(uid, rawConvId);
    let stash = this.rawConvIdToConvStash.get(rawConvId);
    stash.mehUids.push(uid);
    // In the sync_conv case we won't have a dateTS nor will we care about
    // tasks.
    if (dateTS) {
      this._updateTaskWithNewUid(stash, uid, rawConvId, dateTS);
    }
  },

  newMootMessage: function(uid) {
    this.metricWaste++;
  },

  existingIgnoredMessageIsNowYay: function(uid, rawConvId, dateTS) {
    if (this.isKnownRawConvId(rawConvId)) {
      this.newYayMessageInExistingConv(uid, rawConvId, dateTS);
    } else {
      this.newYayMessageInNewConv(uid, rawConvId, dateTS);
    }
  },

  /**
   * The previously yay message is now meh, which potentially means that we
   * no longer care about the message and should purge the conversation from
   * disk.
   */
  existingYayMessageIsNowMeh: function(uid, rawConvId, dateTS, newState) {
    this.metricUseful++;
    this.yayUids.delete(uid);
    this.mehUids.set(uid, rawConvId);
    let stash = this.rawConvIdToConvStash.get(rawConvId);
    stash.yayUids.splice(stash.yayUids.indexOf(uid), 1);
    stash.mehUids.push(uid);
    // If there's no longer anything keeping the conversation alive, convert the
    // task to a deletion task by flagging it as such.  We still keep updating
    // the UIDs in case some subsequent fetch result pushes us back over to
    // keeping the conversation
    this._updateTaskWithModifiedUid(stash, uid, rawConvId, newState);
    if (stash.yayUids.length === 0) {
      this._updateForRemoval(stash);
    }
  },

  /**
   * The previously meh message is now yay, which matters if the conversation
   * ran out of yay messages during this sync "round" and now we need to rescue
   * it from doom.
   */
  existingMehMessageIsNowYay: function(uid, rawConvId, dateTS, newState) {
    this.metricUseful++;
    this.mehUids.delete(uid);
    this.yayUids.set(uid, rawConvId);
    let stash = this.rawConvIdToConvStash.get(rawConvId);
    stash.mehUids.splice(stash.mehUids.indexOf(uid), 1);
    stash.yayUids.push(uid);
    this._updateTaskWithModifiedUid(stash, uid, rawConvId, newState);
    // If we just made this conversation relevant again
    if (stash.yayUids.length === 1) {
      this._updateSavedFromRemoval(stash);
    }
  },

  existingMessageUpdated: function(uid, rawConvId, dateTS, newState) {
    this.metricUseful++;
    let stash = this.rawConvIdToConvStash.get(rawConvId);
    this._updateTaskWithModifiedUid(stash, uid, rawConvId, newState);
  },

  yayMessageDeleted: function(uid) {
    let rawConvId = this.yayUids.get(uid);
    this.yayUids.delete(uid);
    let stash = this.rawConvIdToConvStash.get(rawConvId);
    stash.yayUids.splice(stash.yayUids.indexOf(uid), 1);
    this._updateTaskWithRemovedUid(stash, uid);
    // This deletion may be resulting in the conversation no longer being
    // relevant.
    if (stash.yayUids.length === 0) {
      this._updateForRemoval(stash);
    }
  },

  mehMessageDeleted: function(uid) {
    let rawConvId = this.mehUids.get(uid);
    this.mehUids.delete(uid);
    let stash = this.rawConvIdToConvStash.get(rawConvId);
    stash.mehUids.splice(stash.mehUids.indexOf(uid), 1);
    this._updateTaskWithRemovedUid(stash, uid);
  },

  existingMootMessage: function(uid) {
    this.metricWaste++;
  },

  /**
   * Finalize any pending removals by removing all uid state.  Call this after
   * all sync manipulations have occurred and prior to issuing a database write
   * with our raw state.
   */
  finalizePendingRemovals: function() {
    for (let stash of this._stashesPendingForRemoval) {
      for (let uid of stash.mehUids) {
        this.mehUids.delete(uid);
      }
      this.rawConvIdToConvStash.delete(stash.rawConvId);
    }
    this._stashesPendingForRemoval.clear();
  }
};

return FolderSyncStateHelper;
});

define(function(require) {

let logic = require('../logic');

/**
 * Helper logic for sync tasks to handle interpreting the sync state,
 * manipulating the sync state, and helping track follow-up tasks that may be
 * required.
 *
 * Ideally, this helps make sync_refresh and sync_grow cleaner and easier to
 * read.
 */
function SyncStateHelper(ctx, rawSyncState, accountId) {
  this._ctx = ctx;
  this._accountId = accountId;
  this.rawSyncState = rawSyncState;

  this._labelSinceDates = rawSyncState.labelSinceDates;

  // The UIDs we care about because they meet the sync criteria on their own,
  // and the (raw gmail) conversation id that they belong to.
  this.yayUids = rawSyncState.yayUids;
  // The UIDs we care about because they belong to a conversation we care about,
  // and the (raw gmail) conversation id that they belong to.
  this.mehUids = rawSyncState.mehUids;

  this.rawConvIdToConvStash = new Map();
  this._deriveRawConvIdToConvStash();

  // A running list of tasks to spin-off
  this.tasksToSchedule = [];
}
SyncStateHelper.prototype = {
  _deriveRawConvIdToConvStash: function() {
    let rawConvIdToConvStash = this.rawConvIdToConvStash;
    for (let [yayUid, rawConvId] of this.yayUids) {
      let stash = rawConvIdToConvStash.get(rawConvId);
      if (!stash) {
        stash = {
          yayUids: [yayUid],
          mehUids: [],
          // The most recent message for the conversation we're aware of in this
          // sync batch.  We only care about this for task prioritization
          // reasons, which is why this isn't persisted as part of our state.
          mostRecent: 0,
          task: null
        };
      } else {
        stash.yayUids.push(yayUid);
      }
    }
    for (let [mehUid, rawConvId] of this.mehUids) {
      let stash = rawConvIdToConvStash.get(rawConvId);
      if (!stash) {
        // This should not be happening...
        logic(this._ctx, 'mehWithoutYay',
              { mehUid: mehUid, rawConId: rawConvId });
      } else {
        stash.yayUids.push(yayUid);
      }
    }
  },

  /**
   * Does this message meet our primary sync criteria by having a label that
   * we're interested in and a date that satisfies the SINCE criteria we are
   * using for that label?
   */
  messageMeetsSyncCriteria: function(date, folderIds) {
    let labelSinceDates = this._labelSinceDates;
    for (let folderId of folderIds) {
      let sinceDate = labelSinceDates.get(folderId);
      if (!sinceDate) {
        continue;
      }
      if (date >= sinceDate) {
        return true;
      }
    }

    return false;
  },


  _makeConvTask: function(rawConvId) {
    let convId = this._accountId + '.' + rawConvId;
    let task = {
      type: 'sync_conv',
      accountId: this._accountId,
      convId: convId,
      newConv: false,
      newUids: null,
      mostRecent: 0
    };
    this.tasksToSchedule.push(task);
    return task;
  },

  isKnownRawConvId: function(rawConvId) {
    return this.rawConvIdToConvStash.has(rawConvId);
  },

  /**
   * It's a new message that meets our sync criteria and it's the first message
   * we've heard of in this conversation, so it's a new conversation!
   */
  newYayMessageInNewConv: function(uid, rawConvId, dateTS) {
    this.yayUids.set(uid, rawConvId);
    let yayMehs = {
      yayUids: [uid],
      mehUids: [],
      mostRecent: dateTS,
      task: null
    };
    this.rawConvIdToConvStash.set(rawConvId, yayMehs);

    this._m
    task.newConv = true;
    task.mostRecent = dateTS;
  },

  newYayMessageInExistingConv: function(uid, rawConvId, dateTS) {
    this.yayUids.set(uid, rawConvId);
    let stash = this.rawConvIdToConvStash.get(rawConvId);
    stash.yayUids.push(uid);

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
    if (dateTS > yayMehs.mostRecent) {
      yayMehs.mostRecent = dateTS;
      task.mostRecent = dateTS;
    }
  },

  newMehMessageInExistingConv: function(uid, rawConvId, dateTS) {
  },

  existingYayMessageIsNowMeh: function() {

  },

  existingMehMessageIsNowYay: function() {

  },

  existingMessageUpdated: function() {

  }
};

return SyncStateHelper;
});

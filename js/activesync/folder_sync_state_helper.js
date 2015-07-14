define(function(require) {
'use strict';

let logic = require('logic');

let { convIdFromMessageId } = require('../../id_conversions');

let a64 = require('../../a64');

/**
 * ActiveSync helper logic for folder sync state manipulation.
 *
 * Our sync state contains:
 *
 * - nextUmidSuffix: We allocate unique umid's by prefixing them with our
 *   folderId, and this is the one-up counter that drives that.
 * - syncKey: The sync key that's like an opaque IMAP CONDSTORE MODSEQ.  Almost
 *   any time we manipulate the folder this will change which means that tasks
 *   will need to get exclusive access to us all the time.  Yuck!
 * - filterType: The filter time range we are using for this folder.  Note that
 *   this exists for canonical consistency purposes and if the value ever gets
 *   exposed to the UI, it'll be as a side-effect of the sync process twiddling
 *   some other state.
 * - serverIdInfo: A map from message serverId to umid.
 */
function FolderSyncStateHelper(ctx, rawSyncState, accountId, folderId) {
  if (!rawSyncState) {
    logic(ctx, 'creatingDefaultSyncState', {});
    rawSyncState = {
      nextUmidSuffix: 1,
      syncKey: '0',
      filterType: null,
      serverIdInfo: new Map()
    };
  }

  this._ctx = ctx;
  this._accountId = accountId;
  this._folderId = folderId;
  this.rawSyncState = rawSyncState;

  this._serverIdInfo = this.rawSyncState.serverIdInfo;

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
  get syncKey() {
    return this.rawSyncState.syncKey;
  },

  set syncKey(val) {
    this.rawSyncState.syncKey = val;
  },

  get filterType() {
    return this.rawSyncState.filterType;
  },

  set filterType(val) {
    this.rawSyncState.filterType = val;
  },

  issueUniqueMessageId: function() {
    return (this._folderId + '.' +
            a64.encodeInt(this.rawSyncState.nextUmidSuffix++));
  },

  getUmidForServerId: function(serverId) {
    return this._serverIdInfo.get(serverId);
  },

  /**
   * Track the new, fully populated message, in our serverId mappings.  Most of
   * the legwork has to have already been done by the caller.  (All the message
   * processing is way too much for us to do in here.)
   */
  newMessageWithNewConversation: function(conversation, message) {
    let umid = this.issueUniqueMessageId();
    this.umidLocationWrites.set(umid, [this._folderId, uid]);
    this._makeMessageTask(uid, umid, dateTS, flags);
    this._uidInfo.set(uid, { umid, flagSlot });
  },


  /**
   *
   */
  messageChanged: function(serverId, flagChanges) {
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
   * The message got deleted; make a note of it so that we can put it in a
   * sync_conv later on.
   */
  messageDeleted: function(serverId) {
    let umid = this._serverIdInfo.get(serverId);
    if (!umid) {
      logic.fail('heard about a deletion for an unknown message');
      return;
    }
    this._serverIdInfo.delete(serverId);
    umidDeletions.add(umid);
    umidNameReads.set(umid, null);

    // Nuke the umid location record.  The sync_conv job will take care of the
    // umidName for consistency reasons.
    umidLocationWrites.set(umid, null);
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
      return this._tasksByConvId(convId);
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

return FolderSyncStateHelper;
});

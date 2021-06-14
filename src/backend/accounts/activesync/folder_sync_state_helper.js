import logic from 'logic';

import { convIdFromMessageId } from 'shared/id_conversions';
import { shallowClone } from 'shared/util';

import { encodeInt } from 'shared/a64';

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
 *   some other state.  *This is currently stored as the string value like you'd
 *   find in ItemEstimate.Enums.Status.*
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
  this.umidNameWrites = new Map();
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
            encodeInt(this.rawSyncState.nextUmidSuffix++));
  },

  getUmidForServerId: function(serverId) {
    return this._serverIdInfo.get(serverId);
  },

  /**
   * Track the new, fully populated message, in our serverId mappings.  Most of
   * the legwork has to have already been done by the caller.  (All the message
   * processing is way too much for us to do in here.)
   */
  newMessage: function(serverId, message) {
    let umid = message.umid;
    this.umidNameWrites.set(umid, message.id);
    this.umidLocationWrites.set(umid, [this._folderId, serverId]);
    this._serverIdInfo.set(serverId, umid);
  },

  /**
   * Process changes by tracking the flag changes by umid and noting the umid
   * for a name-read so that we can cluster sync_conv requests later on.
   */
  messageChanged: function(serverId, changes) {
    let umid = this._serverIdInfo.get(serverId);
    this.umidFlagChanges.set(umid, changes.flagChanges);
    this.umidNameReads.set(umid, null);
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
    this.umidDeletions.add(umid);
    this.umidNameReads.set(umid, null);

    // Nuke the umid location record.  The sync_conv job will take care of the
    // umidName for consistency reasons.
    this.umidLocationWrites.set(umid, null);
  },

  /**
   * The sync key was no good, so delete all the messages.  Also, invalidate the
   * syncKey.  Couldn't fit that second sentence in the function name, sorry!
   */
  syncKeyInvalidatedSoDeleteAllMessages: function() {
    this.syncKey = '0';
    for (let serverId of this._serverIdInfo.keys()) {
      this.messageDeleted(serverId);
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

  _ensureConvTask: function(convId) {
    if (this._tasksByConvId.has(convId)) {
      return this._tasksByConvId(convId);
    }

    let task = {
      type: 'sync_conv',
      accountId: this._accountId,
      convId,
      modifiedUmids: null, // Map<UniqueMessageId, FlagChanges>
      removedUmids: null // Set<UniqueMessageId>
    };
    this.tasksToSchedule.push(task);
    this._tasksByConvId.set(convId, task);
    return task;
  },

  /**
   * Just clone the task that triggered us and nuke the stuff that raw tasks
   * aren't supposed to have.  NB: This is probably not the best idea.
   */
  scheduleAnotherRefreshLikeThisOne: function(req) {
    let rawTask = shallowClone(req);
    delete rawTask.exclusiveResources;
    delete rawTask.priorityTags;
    this.tasksToSchedule.push(rawTask);
  }
};

export default FolderSyncStateHelper;

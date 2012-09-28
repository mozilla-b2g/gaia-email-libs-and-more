/**
 * Drives periodic synchronization, covering the scheduling, deciding what
 * folders to sync, and generating notifications to relay to the UI.  More
 * specifically, we have two goals:
 *
 * 1) Generate notifications about new messages.
 *
 * 2) Cause the device to synchronize its offline store periodically with the
 *    server for general responsiveness and so the user can use the device
 *    offline.
 *
 * We use mozAlarm to schedule ourselves to wake up when our next
 * synchronization should occur.
 *
 * All synchronization occurs in parallel because we want the interval that we
 * force the device's radio into higher power modes to be as short as possible.
 *
 * IMPORTANT ARCHITECTURAL NOTE:  This logic is part of the back-end, not the
 * front-end.  We want to serve up the notifications, but we want the front-end
 * to be the one that services them when the user clicks on them.
 **/

define(
  [
    './allback',
    'exports'
  ],
  function(
    $allback,
    exports
  ) {


/**
 * Sanity demands we do not check more frequently than once a minute.
 */
const MINIMUM_SYNC_INTERVAL_MS = 60 * 1000;

/**
 * Caps the number of notifications we generate per account.  It would be
 * sitcom funny to let this grow without bound, but would end badly in reality.
 */
const MAX_MESSAGE_TO_REPORT_PER_ACCOUNT = 5;

/**
 * Implements the interface of `MailSlice` as presented to `FolderStorage`, but
 * it is only interested in accumulating a list of new messages that have not
 * already been read.
 *
 * FUTURE WORK: Listen for changes that make a message that was previously
 * believed to be new no longer new, such as having been marked read by
 * another client.  We don't care about that right now because we lack the
 * ability to revoke notifications via the mozNotifications API.
 */
function CronSlice(storage, callback) {
  this._storage = storage;
  this._callback = callback;

  this.startTS = null;
  this.startUID = null;
  this.endTS = null;
  this.endUID = null;
  this.waitingOnData = false;
  this._accumulating = false;

  this._newHeaders = [];
  // XXX for now, assume that the 30 most recent headers
  this.desiredHeaders = 30;
  this.ignoreHeaders = false;
}
CronSlice.prototype = {
  set ignoreHeaders(ignored) {
    // ActiveSync likes to turn on ignoreHeaders mode because it only cares
    // about the newest messages and it may be told about messages in a stupid
    // order.  But old 'new' messages are still 'new' to us and we have punted
    // on analysis, so we are fine with the potential lossage.  Also, the
    // batch information loses the newness bit we care about...
    //
    // And that's why we ignore the manipulation and always return false in
    // the getter.
  },
  get ignoreHeaders() {
    return false;
  },

  // (copied verbatim for consistency)
  sendEmptyCompletion: function() {
    this.setStatus('synced', true, false);
  },

  setStatus: function(status, requested, moreExpected, flushAccumulated) {
    if (requested && !moreExpected) {
      this._callback(this._newHeaders);
      this.die();
    }
  },

  batchAppendHeaders: function(headers, insertAt, moreComing) {
    // Do nothing, batch-appended headers are always coming from the database
    // and so are not 'new' from our perspective.
  },

  onHeaderAdded: function(header, syncDriven, messageIsNew) {
    // we don't care if it's not new or was read (on another client)
    if (!messageIsNew || header.flags.indexOf('\\Seen') !== -1)
      return;

    // We don't care if we already know about enough new messages.
    // (We could also try and decide which messages are most important, but
    // since this behaviour is not really based on any UX-provided guidance, it
    // would be silly to do that without said guidance.)
  },

  onHeaderModified: function(header) {
    // Do nothing, modified headers are obviously already known to us.
  },

  onHeaderRemoved: function(header) {
    // Do nothing, this would be silly.
  },

  die: function() {
    this._storage.dyingSlice(this);
  },
};

function generateNotificationForMessage(header, onClick, onClose) {
  navigator.mozNotification.createNotification(
    header.author.name || header.author.address,
    header.subject,
    // XXX it makes no sense that the back-end knows the path of the icon,
    // but this specific function may need to vary based on host environment
    // anyways...
    'style/icons/Email.png');
}

/**
 * Creates the synchronizer.  It is does not do anything until the first call
 * to setSyncInterval.
 */
function CronSyncer(universe) {
  this._universe = universe;
  this._syncIntervalMS = 0;

  /**
   * @dictof[
   *   @key[accountId String]
   *   @value[@listof[]]
   * ]{
   *   Terminology-wise, 'notes' is less awkward than 'notifs'...
   * }
   */
  this._outstandingNotesPerAccount = {};

  this._initialized = false;
}
CronSyncer.prototype = {
  /**
   * Remove any/all scheduled alarms.
   */
  _clearAlarms: function() {
    var req = navigator.mozAlarms.getall();
    req.onsuccess = function(event) {
      var alarms = event.target.result;
      for (var i = 0; i < alarms.length; i++) {
        console.log("The contents of an actual alarm:", JSON.stringify(alarms[i]));
        navigator.mozAlarms.remove(alarms[i].id);
      }
    }.bind(this);
  },

  _scheduleNextSync: function() {
    if (!this._syncIntervalMS)
      return;

    navigator.mozAlarms.add(Date.now() + this._syncIntervalMS,
                            'ignoreTimezone');
  },

  setSyncIntervalMS: function(syncIntervalMS) {
    var pendingAlarm = false;
    if (!this._initialized) {
      this._initialized = true;
      pendingAlarm = navigator.mozHasPendingMessage('alarm');
      navigator.mozSetMessageHandler('alarm', this.onAlarm.bind(this));
    }

    // leave zero intact, otherwise round up to the minimum.
    if (syncIntervalMS && syncIntervalMS < MINIMUM_SYNC_INTERVAL_MS)
      syncIntervalMS = MINIMUM_SYNC_INTERVAL_MS;

    // If we have a pending alarm, then our app was loaded to service the
    // alarm, so we should just let the alarm fire which will also take
    // care of rescheduling everything.
    if (pendingAlarm)
      return;

    this._clearAlarms();
    this._scheduleNextSync();
  },

  /**
   * Synchronize the given account.  Right now this is just the Inbox for the
   * account.
   *
   * XXX For IMAP, we really want to use the standard iterative growth logic
   * but generally ignoring the number of headers in the slice and instead
   * just doing things by date.  Since making that correct without breaking
   * things or making things really ugly will take a fair bit of work, we are
   * initially just using the UI-focused logic for this.
   *
   * XXX because of this, we totally ignore IMAP's number of days synced
   * value.  ActiveSync handles that itself, so our ignoring it makes no
   * difference for it.
   */
  syncAccount: function(account, doneCallback) {
    // - Skip syncing if we are offline or the account is disabled
    if (!this.universe.online || !account.enabled) {
      doneCallback([]);
      return;
    }

    // - find the inbox
    var folders = account.folders, inboxFolder;
    // (It would be nice to have a helper for this like the client side has,
    // but we should probably factor it into a mix-in so all account types
    // can use it.)
    for (var iFolder = 0; iFolder < folders.length; iFolder++) {
      if (folders[iFolder].type === 'inbox') {
        inboxFolder = folders[iFolder];
        break;
      }
    }

    var storage = account.getFolderStorageForFolderId(inboxFolder.id);
    // - Skip syncing this account if there is already a sync in progress.

    // XXX for IMAP, there are conceivable edge cases where the user is in the
    // process of synchronizing a window far back in time but would want to hear
    // about new messages in the folder.
    if (storage.syncInProgress) {
      doneCallback([]);
      return;
    }

    // - Figure out how many additional notifications we can generate
    var outstandingNotes;
    if (this._outstandingNotesPerAccount.hasOwnProperty(account.id))
      outstandingNotes = this._outstandingNotesPerAccount[account.id];
    else
      outstandingNotes = this._outstandingNotesPerAccount[account.id] = [];

    // - Initiate a sync of the folder covering the desired time range.
    var slice = new CronSlice(storage, doneCallback);
    // use forceDeepening to ensure that a synchronization happens.
    storage.sliceOpenFromNow(slice, 3, true);

  },

  onAlarm: function() {
    // It would probably be better if we only added the new alarm after we
    // complete our sync, but we could have a problem if
    this._scheduleNextSync();

    var doneOrGaveUp = function doneOrGaveUp(results) {
    }.bind(this);

    var accounts = this._universe.accounts, accountIds = [], account, i;
    for (i = 0; i < accounts.length; i++) {
      account = accounts[i];
      accountIds.push(account.id);
    }
    var callbacks = $allback.allbackMaker(accountIds, doneOrGaveUp);
    for (i = 0; i < accounts.length; i++) {
      account = accounts[i];

    }
  },

  shutdown: function() {
  }
};

}); // end define

/*global define, console, setTimeout */
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
 * This logic is part of the back-end, not the front-end.  We want to notify
 * the front-end of new messages, but we want the front-end to be the one that
 * displays and services them to the user.
 **/

define(
  [
    'rdcommon/log',
    './worker-router',
    './slice_bridge_proxy',
    './mailslice',
    'prim',
    'module',
    'exports'
  ],
  function(
    $log,
    $router,
    $sliceBridgeProxy,
    $mailslice,
    $prim,
    $module,
    exports
  ) {


/**
 * Sanity demands we do not check more frequently than once a minute.
 */
var MINIMUM_SYNC_INTERVAL_MS = 60 * 1000;

/**
 * How long should we let a synchronization run before we give up on it and
 * potentially try and kill it (if we can)?
 */
var MAX_SYNC_DURATION_MS = 3 * 60 * 1000;

/**
 * Caps the number of notifications we generate per account.  It would be
 * sitcom funny to let this grow without bound, but would end badly in reality.
 */
var MAX_MESSAGES_TO_REPORT_PER_ACCOUNT = 5;

/**
 * How much body snippet to save. Chose a value to match the front end
 */
var MAX_SNIPPET_BYTES = 4 * 1024;

function debug(str) {
  console.log("cronsync: " + str + "\n");
}

var SliceBridgeProxy = $sliceBridgeProxy.SliceBridgeProxy;

function makeSlice(storage, callback, parentLog) {
  var proxy = new SliceBridgeProxy({
        __sendMessage: function() {}
      }, 'cron'),
      slice = new $mailslice.MailSlice(proxy, storage, parentLog),
      oldStatus = proxy.sendStatus,
      newHeaders = [];

  slice.onNewHeader = function(header) {
    console.log('onNewHeader: ' + header);
    newHeaders.push(header);
  };

  proxy.sendStatus = function(status, requested, moreExpected,
                              progress, newEmailCount) {
    oldStatus.apply(this, arguments);
    if (requested && !moreExpected && callback) {
      callback(newHeaders);
      slice.die();
    }
  };

  return slice;
}

/**
 * Creates the cronsync instance. Does not do any actions on creation.
 * It waits for a router message or a universe call to start the work.
 */
function CronSync(universe, _logParent) {
  this._universe = universe;
  this._universeDeferred = {};
  this._isUniverseReady = false;

  this._universeDeferred.promise = $prim(function (resolve, reject) {
    this._universeDeferred.resolve = resolve;
    this._universeDeferred.reject = reject;
  }.bind(this));

  this._LOG = LOGFAB.CronSync(this, null, _logParent);

  this._activeSlices = [];

  this._completedEnsureSync = true;
  this._syncAccountsDone = true;

  this._synced = [];

  this.sendCronSync = $router.registerSimple('cronsync', function(data) {
    var args = data.args;
    switch (data.cmd) {
      case 'alarm':
        debug('received an alarm via a message handler');
        this.onAlarm.apply(this, args);
        break;
      case 'syncEnsured':
        debug('received an syncEnsured via a message handler');
        this.onSyncEnsured.apply(this, args);
        break;
    }
  }.bind(this));
  this.sendCronSync('hello');
}

exports.CronSync = CronSync;
CronSync.prototype = {
  _killSlices: function() {
    this._activeSlices.forEach(function(slice) {
      slice.die();
    });
  },

  onUniverseReady: function() {
    this._universeDeferred.resolve();

    this.ensureSync();
  },

  whenUniverse: function(fn) {
    this._universeDeferred.promise.then(fn);
  },

  /**
   * Makes sure there is a sync timer set up for all accounts.
   */
  ensureSync: function() {
    // Only execute ensureSync if it is not already in progress.
    // Otherwise, due to async timing of mozAlarm setting, could
    // end up with two alarms for the same ID.
    if (!this._completedEnsureSync)
      return;

    this._completedEnsureSync = false;

    debug('ensureSync called');

    this.whenUniverse(function() {
      var accounts = this._universe.accounts,
          syncData = {};

      accounts.forEach(function(account) {
        // Store data by interval, use a more obvious string
        // key instead of just stringifying a number, which
        // could be confused with an array construct.
        var interval = account.accountDef.syncInterval,
            intervalKey = 'interval' + interval;

        if (!syncData.hasOwnProperty(intervalKey)) {
          syncData[intervalKey] = [];
        }
        syncData[intervalKey].push(account.id);
      });

      this.sendCronSync('ensureSync', [syncData]);
    }.bind(this));
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
    if (!this._universe.online || !account.enabled) {
      debug('syncAcount early exit: online: ' +
            this._universe.online + ', enabled: ' + account.enabled);
      doneCallback();
      return;
    }

    var done = function(result) {
      // Wait for any in-process job operations to complete, so
      // that the app is not killed in the middle of a sync.
      this._universe.waitForAccountOps(account, function() {
        // Also wait for any account save to finish. Most
        // likely failure will be new message headers not
        // getting saved if the callback is not fired
        // until after account saves.
        account.runAfterSaves(function() {
          doneCallback(result);
        });
      });
    }.bind(this);

    var inboxFolder = account.getFirstFolderWithType('inbox');
    var storage = account.getFolderStorageForFolderId(inboxFolder.id);

    // XXX check when the folder was most recently synchronized and skip this
    // sync if it is sufficiently recent.

    // - Initiate a sync of the folder covering the desired time range.
    this._LOG.syncAccount_begin(account.id);

    var slice = makeSlice(storage, function(newHeaders) {
      this._LOG.syncAccount_end(account.id);
      this._activeSlices.splice(this._activeSlices.indexOf(slice), 1);

      // Reduce headers to the minimum number and data set needed for
      // notifications.
      var notifyHeaders = [];
      newHeaders.some(function(header, i) {
        notifyHeaders.push({
          date: header.date,
          from: header.author.name || header.author.address,
          subject: header.subject,
          accountId: account.id,
          messageSuid: header.suid
        });

        if (i === MAX_MESSAGES_TO_REPORT_PER_ACCOUNT - 1)
          return true;
      });

      if (newHeaders.length) {
        debug('Asking for snippets for ' + notifyHeaders.length + ' headers');
        if (this._universe.online){
          this._universe.downloadBodies(
            newHeaders.slice(0, MAX_MESSAGES_TO_REPORT_PER_ACCOUNT), {
              maximumBytesToFetch: MAX_SNIPPET_BYTES
            }, function() {
              debug('Notifying for ' + newHeaders.length + ' headers');
              done([newHeaders.length, notifyHeaders]);
          }.bind(this));
        } else {
          debug('UNIVERSE OFFLINE. Notifying for ' + newHeaders.length +
                ' headers');
          done([newHeaders.length, notifyHeaders]);
        }
      } else {
        done();
      }
    }.bind(this), this._LOG);

    this._activeSlices.push(slice);
    // Pass true to force contacting the server.
    storage.sliceOpenMostRecent(slice, true);
  },

  onAlarm: function(accountIds) {
    this.whenUniverse(function() {
      this._LOG.alarmFired();

      if (!accountIds)
        return;

      var accounts = this._universe.accounts,
          targetAccounts = [],
          ids = [];

      this._universe.__notifyStartedCronSync(accountIds);

      // Make sure the acount IDs are still valid. This is to protect agains
      // an account deletion that did not clean up any alarms correctly.
      accountIds.forEach(function(id) {
        accounts.some(function(account) {
          if (account.id === id) {
            targetAccounts.push(account);
            ids.push(id);
            return true;
          }
        });
      });

      // Flip switch to say account syncing is in progress.
      this._syncAccountsDone = false;

      // Make sure next alarm is set up. In the case of a cold start
      // background sync, this is a bit redundant in that the startup
      // of the mailuniverse would trigger this work. However, if the
      // app is already running, need to be sure next alarm is set up,
      // so ensure the next sync is set up here. Do it here instead of
      // after a sync in case an error in sync would prevent the next
      // sync from getting scheduled.
      this.ensureSync();

      var syncMax = targetAccounts.length,
          syncCount = 0,
          accountsResults = {
            accountIds: accountIds
          };

      var done = function() {
        syncCount += 1;
        if (syncCount < syncMax)
          return;

        // Kill off any slices that still exist from the last sync.
        this._killSlices();

        // Wrap up the sync
        this._syncAccountsDone = true;
        this._onSyncDone = function() {
          if (this._synced.length) {
            accountsResults.updates = this._synced;
            this._synced = [];
          }

          this._universe.__notifyStoppedCronSync(accountsResults);
        }.bind(this);

        this._checkSyncDone();
      }.bind(this);

      // Nothing new to sync, probably old accounts. Just return and indicate
      // that syncing is done.
      if (!ids.length) {
        return done();
      }

      targetAccounts.forEach(function(account) {
        this.syncAccount(account, function (result) {
          if (result) {
            this._synced.push({
              id: account.id,
              address: account.identities[0].address,
              count: result[0],
              latestMessageInfos: result[1]
            });
          }
          done();
        }.bind(this));
      }.bind(this));
    }.bind(this));
  },

  /**
   * Checks for "sync all done", which means the ensureSync call completed, and
   * new alarms for next sync are set, and the account syncs have finished. If
   * those two things are true, then notify the universe that the sync is done.
   */
  _checkSyncDone: function() {
    if (!this._completedEnsureSync || !this._syncAccountsDone)
      return;

    if (this._onSyncDone) {
      this._onSyncDone();
      this._onSyncDone = null;
    }
  },

  /**
   * Called from cronsync-main once ensureSync as set
   * any alarms needed. Need to wait for it before
   * signaling sync is done because otherwise the app
   * could get closed down before the alarm additions
   * succeed.
   */
  onSyncEnsured: function() {
    this._completedEnsureSync = true;
    this._checkSyncDone();
  },

  shutdown: function() {
    $router.unregister('cronsync');
    this._killSlices();
  }
};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  CronSync: {
    type: $log.DAEMON,
    events: {
      alarmFired: {},
    },
    TEST_ONLY_events: {
    },
    asyncJobs: {
      syncAccount: { id: false },
    },
    errors: {
    },
    calls: {
    },
    TEST_ONLY_calls: {
    },
  },
});

}); // end define

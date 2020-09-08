/* eslint-disable no-prototype-builtins */
import logic from 'logic';
import wakelocks from './wakelocks-main';
const requestWakeLock = wakelocks.requestWakeLock;

function makeData(accountIds, interval, date) {
  return {
    type: 'sync',
    accountIds: accountIds,
    interval: interval,
    timestamp: date.getTime()
  };
}

// Creates a string key from an array of string IDs. Uses a space
// separator since that cannot show up in an ID.
function makeAccountKey(accountIds) {
  return 'id' + accountIds.join(' ');
}

// Converts 'interval' + intervalInMillis to just a intervalInMillis
// Number.
var prefixLength = 'interval'.length;
function toInterval(intervalKey) {
  return parseInt(intervalKey.substring(prefixLength), 10);
}

// Makes sure two arrays have the same values, account IDs.
function hasSameValues(ary1, ary2) {
  if (ary1.length !== ary2.length) {
    return false;
  }

  var hasMismatch = ary1.some(function(item, i) {
    return item !== ary2[i];
  });

  return !hasMismatch;
}

/**
 * Super-hack that peeks at the notifications that are still present and
 * figures out if they are from newness/syncs and what account id's they
 * correspond to.  This allows gaia mail to continue to fast-close if a
 * notification "close" event was sent while still maintaining the UX logic
 * that if they closed the notification then they don't care about any of
 * those messages being new.  What happens is we send this list and the
 * cronsync logic gets to transform those missing id's into requests to clear
 * the newness status before triggering the syncs.
 *
 * Note that the newness clears happen across all accounts, not just the
 * accounts we are
 */
function getAccountsWithOutstandingSyncNotifications() {
  if (typeof Notification !== 'function' || !Notification.get) {
    return Promise.resolve([]);
  }

  return Notification.get().then(function(notifications) {
    var result = [];
    notifications.forEach(function(notification) {
      var data = notification.data;

      if (data.v && data.ntype === 'sync') {
        result.push(data.accountId);
      }
    });
    return result;
  }, function() {
    return [];
  });
}

// This weird circular registration is because of how the router works and
// does its registration via "dispatch"-table indirection which has wonky this
// implications.  It's a non-idiomatic legacy hackjob thing.  I'm writing this
// comment instead of fixing it because 1) I experienced a WTF when revising
// the app logic here, and 2) the "fixing" should entail moving to `bridge.js`
// rather than wasting more effort on our router impl.
var routeRegistration;
var dispatcher = {
  _routeReady: false,
  _routeQueue: [],
  _sendMessage: function(type, args) {
    if (this._routeReady) {
      // sendMessage is added to routeRegistration by the main-router module.
      routeRegistration.sendMessage(null, type, args);
    } else {
      this._routeQueue.push([type, args]);
    }
  },

  /**
   * Called by worker side to indicate it can now receive messages.
   */
  hello: function() {
    this._routeReady = true;
    if (this._routeQueue.length) {
      var queue = this._routeQueue;
      this._routeQueue = [];
      queue.forEach(function(args) {
        this._sendMessage(args[0], args[1]);
      }.bind(this));
    }
  },

  /**
   * Clears all sync-based alarms. Normally not called, except perhaps for
   * tests or debugging.
   */
  clearAll: function() {
    var mozAlarms = navigator.mozAlarms;
    if (!mozAlarms) {
      return;
    }

    var r = mozAlarms.getAll();

    r.onsuccess = function(event) {
      var alarms = event.target.result;
      if (!alarms) {
        return;
      }

      alarms.forEach(function(alarm) {
        if (alarm.data && alarm.data.type === 'sync') {
          mozAlarms.remove(alarm.id);
        }
      });
    }.bind(this);
    r.onerror = function(err) {
      console.error('cronsync-main clearAll mozAlarms.getAll: error: ' +
                    err);
    }.bind(this);
  },

  /**
   * Makes sure there is an alarm set for every account in the list.

    * @param  {Object} syncData. An object with keys that are 'interval' +
    * intervalInMilliseconds, and values are arrays of account IDs that should
    * be synced at that interval.
    */
  ensureSync: function (syncData) {
    var mozAlarms = navigator.mozAlarms;
    if (!mozAlarms) {
      console.warn('no mozAlarms support!');
      return;
    }

    logic(this, 'ensureSync:begin');

    var request = mozAlarms.getAll();

    request.onsuccess = (event) => {
      logic(this, 'ensureSync:gotAlarms');

      var alarms = event.target.result;
      // If there are no alarms a falsey value may be returned.  We want
      // to not die and also make sure to signal we completed, so just make
      // an empty list.
      if (!alarms) {
        alarms = [];
      }

      // Find all IDs being tracked by alarms
      var expiredAlarmIds = [],
          okAlarmIntervals = {},
          uniqueAlarms = {};

      alarms.forEach((alarm) => {
        // Only care about sync alarms.
        if (!alarm.data || !alarm.data.type || alarm.data.type !== 'sync') {
          return;
        }

        var intervalKey = 'interval' + alarm.data.interval,
            wantedAccountIds = syncData[intervalKey];

        if (!wantedAccountIds || !hasSameValues(wantedAccountIds,
                                                alarm.data.accountIds)) {
          logic(
            this,
            'ensureSyncAccountMismatch',
            {
              alarmId: alarm.id,
              alarmAccountIds: alarm.data.accountIds,
              wantedAccountIds
            });
          expiredAlarmIds.push(alarm.id);
        } else {
          // Confirm the existing alarm is still good.
          var interval = toInterval(intervalKey),
              now = Date.now(),
              alarmTime = alarm.data.timestamp,
              accountKey = makeAccountKey(wantedAccountIds);

          // If the interval is nonzero, and there is no other alarm found
          // for that account combo, and if it is not in the past and if it
          // is not too far in the future, it is OK to keep.
          if (interval && !uniqueAlarms.hasOwnProperty(accountKey) &&
              alarmTime > now && alarmTime < now + interval) {
            logic(
              this,
              'ensureSyncAlarmOK',
              { alarmId: alarm.id, accountKey, intervalKey });
            uniqueAlarms[accountKey] = true;
            okAlarmIntervals[intervalKey] = true;
          } else {
            logic(
              this,
              'ensureSyncAlarmOutOfRange',
              { alarmId: alarm.id, accountKey, intervalKey });
            expiredAlarmIds.push(alarm.id);
          }
        }
      });

      expiredAlarmIds.forEach((alarmId) => {
        mozAlarms.remove(alarmId);
      });

      var alarmMax = 0,
          alarmCount = 0,
          self = this;

      // Called when alarms are confirmed to be set.
      var done = () => {
        alarmCount += 1;
        if (alarmCount < alarmMax) {
          return;
        }

        logic(this, 'ensureSync:end');
        // Indicate ensureSync has completed because the
        // back end is waiting to hear alarm was set before
        // triggering sync complete.
        self._sendMessage('syncEnsured');
      };

      Object.keys(syncData).forEach((intervalKey) => {
        // Skip if the existing alarm is already good.
        if (okAlarmIntervals.hasOwnProperty(intervalKey)) {
          return;
        }

        var interval = toInterval(intervalKey),
            accountIds = syncData[intervalKey],
            date = new Date(Date.now() + interval);

        // Do not set an timer for a 0 interval, bad things happen.
        if (!interval) {
          return;
        }

        alarmMax += 1;

        var alarmRequest = mozAlarms.add(date, 'ignoreTimezone',
                                      makeData(accountIds, interval, date));

        alarmRequest.onsuccess = () => {
          logic(
            this,
            'ensureSyncAlarmAdded',
            { accountIds, interval });
          done();
        };

        alarmRequest.onerror = (err) => {
          logic(
            this,
            'ensureSyncAlarmAddError',
            { accountIds, interval, err });
          done();
        };
      });

      // If no alarms were added, indicate ensureSync is done.
      if (!alarmMax) {
        done();
      }
    };

    request.onerror = (err) => {
      logic(this, 'ensureSyncGetAlarmsError', { err });
    };
  }
};
logic.defineScope(dispatcher, 'CronsyncMain');

if (navigator.mozSetMessageHandler) {
  navigator.mozSetMessageHandler('alarm', (alarm) => {
    logic(dispatcher, 'alarmFired');

    // !! Coordinate with the gaia mail app frontend logic !!
    // html_cache_restore.js has some logic that tries to cleverly close the
    // app if the app was only woken up because the user closed a
    // notification.  (This is not something the front-end or we in the
    // back-end care about.)
    //
    // Previously, our setting this variable might matter.  As of the writing
    // of this comment, it's technically impossible for us to matter.
    // However, we still look for this flag and set it in order to provide a
    // strong observable invariant about our message handler.  We do this
    // even though it's a little paranoid because once this message handler
    // fires, the system message/alarm will have been eaten and so it would
    // super-suck to race front-end logic somehow.
    if (window.hasOwnProperty('appShouldStayAlive')) {
      window.appShouldStayAlive = 'alarmFired';
    }

    // If this is not a notification displaying cronsync results, ignore it.
    // The other known message types at this time are:
    // - message_reader: Used for background send error notifications.
    var data = alarm.data;
    if (!data || data.type !== 'sync') {
      return;
    }

    // We must acquire a CPU wakelock before we return to the caller for
    // correctness reasons.  (SystemMessagesInternal holds a wakelock on our
    // behalf until our callback returns.)  So we do that here.
    //
    // We acquire the wakelock using the main-side of our smart wakelock
    // implementation.  When we send the notification to CronSyncSupport, we
    // pass the lock id, allowing CronSyncSupport to assume responsbility for
    // the wakelock, including upgrading it to a full smart wakelock.
    //
    // (Previously we had an "evt" convention with the front-end logic, but
    // that was done for hacky stop-gap reasons and because GELAM did not have
    // explicit wakelock support itself.)

    var wakelockId = requestWakeLock('cpu');

    getAccountsWithOutstandingSyncNotifications().then(
      (accountIdsWithNotifications) => {
        logic(dispatcher, 'alarmDispatch');

        dispatcher._sendMessage(
          'alarm',
          [data.accountIds, data.interval, wakelockId,
            accountIdsWithNotifications]);
      });
  });
}

routeRegistration = {
  name: 'cronsync',
  sendMessage: null,
  dispatch: dispatcher
};

export default routeRegistration;

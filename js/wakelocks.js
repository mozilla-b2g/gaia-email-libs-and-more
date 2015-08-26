define(function(require) {
  'use strict';

  const logic = require('logic');

  const $router = require('./worker-router');
  const sendMessage = $router.registerCallbackType('wakelocks');

  /**
   * SmartWakeLock: A renewable, failsafe Wake Lock manager.
   *
   * Example:
   *   var lock = new SmartWakeLock({ locks: ['cpu', 'screen'] });
   *   // do things; if we do nothing, the lock expires eventually.
   *   lock.renew(); // Keep the lock around for a while longer.
   *   // Some time later...
   *   lock.unlock();
   *
   * Grab a set of wake locks, holding on to them until either a
   * failsafe timeout expires, or you release them.
   *
   * @param {int} opts.timeout
   *   Timeout, in millseconds, to hold the lock if you fail to call
   *   .unlock().
   * @param {String[]} opts.locks
   *   Array of strings, e.g. ['cpu', 'wifi'], representing the locks
   *   you wish to acquire.
   */
  function SmartWakeLock(opts) {
    logic.defineScope(this, 'SmartWakeLock', { unique: Date.now() });
    this.timeoutMs = opts.timeout || SmartWakeLock.DEFAULT_TIMEOUT_MS;
    var locks = this.locks = {}; // map of lockType -> wakeLockInstance

    this._timeout = null; // The ID returned from our setTimeout.

    // Since we have to fling things over the bridge, requesting a
    // wake lock here is asynchronous. Using a Promise to track when
    // we've successfully acquired the locks (and blocking on it in
    // the methods on this class) ensures that folks can ignore the
    // ugly asynchronous parts and not worry about when things happen
    // under the hood.
    this._readyPromise = Promise.all(opts.locks.map((type) => {
      logic(this, 'requestLock', { type, durationMs: this.timeoutMs });
      return new Promise((resolve) => {
        sendMessage('requestWakeLock', [type], (lockId) => {
          logic(this, 'locked', { type });
          locks[type] = lockId;
          resolve();
        });
      });
    })).then(() => {
      // For simplicity of implementation, we reuse the `renew` method
      // here to add the initial `opts.timeout` to the unlock clock.
      this.renew(); // Start the initial timeout.
    });
  }

  SmartWakeLock.DEFAULT_TIMEOUT_MS = 45000;

  SmartWakeLock.prototype = {
    /**
     * Renew the timeout, if you're certain that you still need to hold
     * the locks longer.
     */
    renew: function(/* optional */ reason) {
      // Wait until we've successfully acquired the wakelocks, then...
      return this._readyPromise.then(() => {
        // If we've already set a timeout, we'll clear that first.
        // (Otherwise, we're just loading time on for the first time,
        // and don't need to clear or log anything.)
        if (this._timeout) {
          clearTimeout(this._timeout);
          logic(this, 'renew',
                {
                  reason,
                  renewDurationMs: this.timeoutMs,
                  durationLeftMs: (this.timeoutMs -
                               (Date.now() - this._timeLastRenewed))
                });
        }

        this._timeLastRenewed = Date.now(); // Solely for debugging.

        this._timeout = setTimeout(() => {
          logic(this, 'timeoutUnlock');
          this.unlock('timeout');
        }, this.timeoutMs);
      });
    },

    /**
     * Unlock all the locks. This happens asynchronously behind the
     * scenes; if you want to block on completion, hook onto the
     * Promise returned from this function.
     */
    unlock: function(/* optional */ reason) {
      // Make sure weve been locked before we try to unlock. Also,
      // return the promise, throughout the chain of calls here, so
      // that listeners can listen for completion if they need to.
      return this._readyPromise.then(() => {
        var locks = this.locks;
        this.locks = {}; // Clear the locks.
        clearTimeout(this._timeout);
        this._timeout = null;

        // Wait for all of them to successfully unlock.
        return Promise.all(Object.keys(locks).map((type) => {
          return new Promise((resolve) => {
            sendMessage('unlock', [locks[type]], () => {
              resolve(type);
            });
          });
        })).then((type) => {
          logic(this, 'unlocked', { type, reason });
        });
      });
    },

    toString: function() {
      return Object.keys(this.locks).join('+') || '(no locks)';
    },
  };

  return {
    SmartWakeLock: SmartWakeLock
  };
});

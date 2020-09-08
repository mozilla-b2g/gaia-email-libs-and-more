import logic from 'logic';

import * as $router from './worker-router';
const sendWakeLockMessage = $router.registerCallbackType('wakelocks');

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
 * @param {Function} [opts.imminentDoomHandler]
 *   A function you can provide that we'll call when the timeout occurs.
 *   We'll invoke it immediately prior to performing the unlock so that you
 *   can front-run our removal of the wake-lock.  You can also clobber this
 *   onto us later on or clear it.
 */
export function SmartWakeLock(opts) {
  logic.defineScope(this, 'SmartWakeLock', { types: opts.locks });

  var locks = this.locks = {}; // map of lockType -> wakeLockInstance
  this.timeoutMs = opts.timeout || SmartWakeLock.DEFAULT_TIMEOUT_MS;
  this._timeout = null; // The ID returned from our setTimeout.
  this.imminentDoomHandler = opts.imminentDoomHandler || null;

  // magic path for use by wrapMainThreadAcquiredWakelock ONLY
  if (opts.__existingLockId) {
    this.locks[opts.locks[0]] = opts.__existingLockId;
    logic(this, 'reusedMainthreadLock');
    this._readyPromise = Promise.resolve();
    this.renew(); // start the clock ticking!
    return;
  }

  // Since we have to fling things over the bridge, requesting a
  // wake lock here is asynchronous. Using a Promise to track when
  // we've successfully acquired the locks (and blocking on it in
  // the methods on this class) ensures that folks can ignore the
  // ugly asynchronous parts and not worry about when things happen
  // under the hood.
  logic(this, 'requestLock', { durationMs: this.timeoutMs });
  this._readyPromise = Promise.all(opts.locks.map((type) => {
    return sendWakeLockMessage('requestWakeLock', [type]).then((lockId) => {
      locks[type] = lockId;
    });
  })).then(() => {
    logic(this, 'locked', {});
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
        if (this.imminentDoomHandler) {
          try {
            // doomity doom doom!
            this.imminentDoomHandler();
          }
          catch (ex) {
            // do nothing, we just don't want to fail to unlock the wakelock.
          }
        }
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

      logic(this, 'unlock', { reason });
      // Wait for all of them to successfully unlock.
      return Promise.all(Object.keys(locks).map((type) => {
        return sendWakeLockMessage('unlock', [locks[type]], () => {
          return type;
        });
      })).then(() => {
        logic(this, 'unlocked', { reason });
      });
    });
  },

  toString: function() {
    return Object.keys(this.locks).join('+') || '(no locks)';
  },
};

/**
 * If your main-thread helper called wakelocks-main.js's requestWakeLock
 * method and handed you the id, this is where you convert that id into your
 * very own `SmartWakeLock` just like you had new'ed it.
 *
 * This method exists to make things very explicit and to avoid the subtle
 * breakage that might occur if our contract was to use a dictionary arg
 * (which can get typo'd or missed in a renaming pass, etc.).
 */
export function wrapMainThreadAcquiredWakelock({ wakelockId, timeout,
    imminentDoomHandler }) {
  return new SmartWakeLock({
    locks: ['mainthread-acquired'],
    timeout,
    imminentDoomHandler,
    __existingLockId: wakelockId
  });
}

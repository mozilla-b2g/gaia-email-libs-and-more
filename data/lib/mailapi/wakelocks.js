define(function(require) {
  'use strict';

  var $router = require('./worker-router');
  var sendMessage = $router.registerCallbackType('wakelocks');

  /**
   * Grab a set of wake locks, holding on to them until either a
   * failsafe timeout expires, or you release them.
   *
   * @param {int} opts.timeout Timeout, in millseconds, to hold the lock
   *                           if you fail to call .unlock().
   * @param {String[]} opts.locks Array of strings, e.g. ['cpu', 'wifi'].
   * @param {function callback when ready, probably unimportant
   */
  function SmartWakeLock(opts, callback) {
    this.timeoutMs = opts.timeout || 45000;
    var locks = this.locks = {}; // map of lockType -> wakeLockInstance

    this.readyPromise = Promise.all(opts.locks.map(function(type) {
      return new Promise(function(resolve, reject) {
        sendMessage('requestWakeLock', [type], function(lockId) {
          locks[type] = lockId;
          resolve();
        });
      });
    })).then(function() {
      this._debug('Acquired', this, 'for', this.timeoutMs + 'ms');
      this.renew(); // Start the initial timeout.
    }.bind(this));
  }

  SmartWakeLock.prototype = {
    /**
     * Renew the timeout, if you're certain that you still need to hold
     * the locks longer.
     */
    renew: function(/* optional */ reason, callback) {
      if (typeof reason === 'function') {
        callback = reason;
        reason = null;
      }

      this.readyPromise.then(function() {
        if (this._timeout) {
          clearTimeout(this._timeout);
          this._debug('Renewing', this, 'for another', this.timeoutMs + 'ms' +
                      (reason ? ' (reason: ' + reason + ')' : '') + ',',
                      'would have expired in ' +
                      (this.timeoutMs - (Date.now() - this._timeLastRenewed)) +
                      'ms if not renewed.');
        }

        this._timeLastRenewed = Date.now();
        this._timeout = setTimeout(function() {
          this._debug('*** Unlocking', this,
                      'due to a TIMEOUT. Did you remember to unlock? ***');
          this.unlock.bind(this);
        }.bind(this), this.timeoutMs);

        callback && callback();
      }.bind(this));
    },

    /**
     * Unlock all the locks.
     */
    unlock: function(/* optional */ reason, callback) {
      if (typeof reason === 'function') {
        callback = reason;
        reason = null;
      }
      this.readyPromise.then(function() {
        var desc = this.toString();

        var locks = this.locks;
        this.locks = {};
        clearTimeout(this._timeout);

        Promise.all(Object.keys(locks).map(function(type) {
          return new Promise(function(resolve, reject) {
            sendMessage('unlock', [locks[type]], function(lockId) {
              resolve();
            });
          });
        })).then(function() {
          this._debug('Unlocked', desc + '.');
          callback && callback;
        }.bind(this));

      }.bind(this));
    },

    toString: function() {
      return Object.keys(this.locks).join('+') || '(no locks)';
    },

    _debug: function() {
      var args = Array.slice(arguments);
      console.log.apply(console, ['SmartWakeLock:'].concat(args));
    }
  };

  return {
    SmartWakeLock: SmartWakeLock
  };

});

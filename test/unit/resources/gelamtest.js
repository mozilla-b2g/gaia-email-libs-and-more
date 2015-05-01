define(function(require) {

  var logic = require('logic');
  var contexts = require('./contexts');
  var co = require('co');

  // Only set up the contexts once per test file.
  var existingMailAPI = null;

  var originalWindowConsole = window.console;

  /**
   * Consruct a new GelamTest (as you would return from a test module) with the
   * given options and method. The test function you provide should return a
   * Promise that resolves when your test has completed (or rejects if your test
   * fails).
   *
   * @param {string} name
   *   Human-readable test name.
   * @param {object} [options]
   *   Optional. Currently no public options are supported.
   * @param {function(MailAPI)} fn
   *   Test function. Accepts the MailAPI instance as the first parameter.
   *   Should return a Promise with the result of your test.
   */
  function GelamTest(name, options, fn) {
    if (typeof options === 'function') {
      fn = options;
      options = {};
    }
    this.name = name;
    this.options = options;
    if (fn.constructor.name === 'GeneratorFunction') {
      fn = co.wrap(fn.bind(this));
    }
    this.fn = fn;
    logic.underTest = true;
    logic.defineScope(this, 'GelamTest');
  }

  GelamTest.prototype = {

    /**
     * Gather up the logs for this test result, noting if an error caused the
     * test to fail.
     */
    gatherLogs: function(lastError) {
      var lastErrorSummary = null;
      if (lastError) {
        lastErrorSummary = lastError.toString();
        if (lastError.stack) {
          lastErrorSummary += '\n' + lastError.stack;
        }
      }
      return {
        type: 'test',
        name: this.name,
        variant: this.options.variant,
        result: lastError ? 'fail' : 'pass',
        lastError: lastErrorSummary,
        events: this._logs
      }
    },

    _shimConsole: function() {
      var scope = logic.scope('Console');
      ['log', 'info', 'warn', 'error'].forEach((name) => {
        window.console[name] = function() {
          var args = [];
          for (var i = 0; i < arguments.length; i++) {
            args.push(arguments[i] + '');
          }
          logic(scope, name, { string: args.join(' ') });
        }
      });
    },

    _currentGroupAsyncCallbacks: null,

    /**
     * For convenience, mark a semantic group within your test logic. Only one
     * group can be active at a time; when one group begins, the previous group
     * is closed. Not hierarchical.
     */
    group: function(str) {
      if (this._currentGroupAsyncCallbacks) {
        this._currentGroupAsyncCallbacks.resolve();
      }
      this._currentGroupAsyncCallbacks =
        logic.startAsync(this, 'group', { name: str });
    },

    /**
     * Run the test with the given environment options.
     *
     * Possible options:
     *   variant: 'imap:fake', etc.
     *
     * Returns a Promise.
     */
    run: function(options) {
      dump('===============================================================\n');
      dump('  RUNNING TEST ' + this.name + '\n\n')
      for (var key in options) {
        this.options[key] = options[key];
      }

      // Start recording events.
      this._logs = [];
      var handleEvent = (event) => {
        this._logs.push(event.toJSON());
      };

      logic.on('event', handleEvent);

      return Promise.resolve()
        .then(() => {

          // Initialize the MailAPI if necessary.
          if (!this.options.legacy) {
            if (!existingMailAPI) {
              this._shimConsole();
              this.group('Initialize MailAPI');
              return contexts.init(this.options);
            } else {
              return existingMailAPI;
            }
          }
        })
        .then((MailAPI) => {
          existingMailAPI = MailAPI;

          // Run or timeout, which one will win?
          return Promise.race([
            new Promise((resolve, reject) => {
              logic._currentTestRejectFunction = reject;
            }),
            Promise.resolve(this.fn.call(this, MailAPI)),
            new Promise((resolve, reject) => {
              setTimeout(() => {
                reject(new Error('GelamTest Timeout'));
              }, 15000);
            })
          ])
        })
        .then(() => {
          // Close out the final group, if necessary.
          if (this._currentGroupAsyncCallbacks) {
            this._currentGroupAsyncCallbacks.resolve();
          }
          logic.removeListener('event', handleEvent);
          logic._currentTestRejectFunction = null;
          return this.gatherLogs(/* no error! */);
        }).catch((ex) => {
          // Close out the group, noting why it failed.
          if (this._currentGroupAsyncCallbacks) {
            this._currentGroupAsyncCallbacks.reject(ex);
          }
          // Try to make exceptions a bit better.
          if (ex.toString() === '[object Object]') {
            try {
              ex = JSON.stringify(ex);
            } catch (e) {
            }
          }
          console.error('Fatal test error:', ex);
          logic(this, 'error', { msg: ex.toString(), stack: ex.stack });
          logic.removeListener('event', handleEvent);
          return this.gatherLogs(ex);
        });
    }
  }

  return GelamTest;

});

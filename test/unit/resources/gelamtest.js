define(function(require) {

  var logic = require('logic');
  var contexts = require('./contexts');

  function GelamTest(name, opts, fn) {
    if (typeof opts === 'function') {
      fn = opts;
      opts = {};
    }
    this.name = name;
    this.opts = opts;
    this.fn = fn;
    this.envOptions = {};
    this.fileBlackboard = {};
  }

  GelamTest.prototype = {
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
        variant: this.envOptions.variant,
        result: lastError ? 'fail' : 'pass',
        lastError: lastErrorSummary,
        events: this._logs
      }
    },

    run: function(envOptions) {
      for (var key in envOptions) {
        this.envOptions[key] = envOptions[key];
      }

      this._logs = [];
      var handleEvent = (event) => {
        this._logs.push(event.toJSON());
      };

      logic.on('*', handleEvent);
      return Promise.resolve()
      //      .then(() => contexts.init(opts))
        .then(() => this.fn.call(this))
        .then(() => {
          logic.removeListener('*', handleEvent);
          return this.gatherLogs();
        }).catch((ex) => {
          logic.removeListener('*', handleEvent);
          console.error(ex);
          return this.gatherLogs(ex);
        });
    }
  }

  return GelamTest;

});

define(function(require) {

  var logic = require('logic');
  var contexts = require('./contexts');

  function GelamTest(name, options, fn) {
    if (typeof options === 'function') {
      fn = options;
      options = {};
    }
    this.name = name;
    this.options = options;
    this.fn = fn;
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
        variant: this.options.variant,
        result: lastError ? 'fail' : 'pass',
        lastError: lastErrorSummary,
        events: this._logs
      }
    },

    run: function(options) {
      for (var key in options) {
        this.options[key] = options[key];
      }

      this._logs = [];
      var handleEvent = (event) => {
        this._logs.push(event.toJSON());
      };

      logic.on('*', handleEvent);
      return Promise.resolve()
        .then(() => {
          if (!this.options.legacy) {
            return contexts.init(this.env)
          };
        })
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

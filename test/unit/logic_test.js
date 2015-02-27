define(function(require) {
  var logic = require('logic');
  var contexts = require('contexts');
  var assert = require('assert');
  var { frontend, backend } = require('contexts');

  function viewFolder() {
    return frontend(() => {
      this.MailAPI.init();
    });
  }

  function GelamTest(name, opts, fn) {
    if (typeof opts === 'function') {
      fn = opts;
      opts = {};
    }

    this.logs = [];
    logic.firehose((event) => {
      this.logs.push(event);
    });
    this.name = name;
    this.promise = Promise.resolve()
      .then(() => contexts.init(opts))
      .then(() => fn());
  }
  GelamTest.prototype = {
    reportResults: function() {
      var resultsJson = {
        type: 'logic',
        name: this.name,
        // XXX add variant
        events: this.logs
      };
      console.log(JSON.stringify(resultsJson, null, ' '));
      this.resultsReporter(resultsJson);
    },
    // Can't use "then" because alameda eats it.
    whenDone: function(fn, catchFn) {
      this.promise.then(fn, (e) => {
        logic.error(e);
        catchFn(e);
      });
    }
  }

  return new GelamTest('Runs a thing', () => {
    function oneSecondPromise() {
      return logic.bind({ ns: 'time'})
        .async('make one sec', (r) => setTimeout(() => r('1s'), 1000));
    }

    this.logic = logic.bind({ ns: 'mainApp' });

    var logs = this.logic.follow();

    return this.logic.await("one-second-promise", oneSecondPromise())
      .then(() => {
        this.logic.log("Await done!");
      }).then(() => {
        logs.match('foo');
      });

    // return frontend((ctx) => {
    //   logic.log('got api');
    //   console.log("API", ctx.api);
    //   return 2;
    // }).then((value) => {
    //   logic.log('then value', value);
    //   return backend((ctx) => {
    //     console.log("CTX@@@", JSON.stringify(Object.keys(ctx)));
    //   });
    // }).then(() => {
    //   logic.log("#####################################");
    // });
  });
});

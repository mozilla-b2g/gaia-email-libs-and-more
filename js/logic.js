define('logic', function(require) {
  /**
   * Logic is a structured logging library.
   * ================================================================
   *
   * Logic embeds the structure, control flow, and Promise chain into
   * your logs, allowing you to better understand your logfiles in an
   * asynchronous, complex world.
   *
   * By default, Logic exposes the root logger.
   *
   *     var logic = require('logic');
   *
   * You can create a child logger like so:
   *
   *     var sublog = logic.subset('Account1');
   *
   * Logic supports four logging functions, in order of urgency:
   *
   *     .log(...)   -> Routine, uninteresting logs.
   *     .info(...)  -> Notable typical events.
   *     .warn(...)  -> Something's amiss!
   *     .error(...) -> Crap, something's wrong; likely an exception.
   *
   * Each of these logging functions have the following signatures:
   *
   *     logic.log(String name);
   *     logic.log(String name, Object details);
   *
   * Details is optional, but must be an Object if provided.
   *
   * Therefore, a couple of log entries might look like the following:
   *
   *   level      hierarchy           name          details
   *   -----  -----------------   ------------  ---------------
   *   INFO   Net.IMAP.Account1 / connected     { code: 200 }
   *   INFO   Net.IMAP.Account1 / idle
   *   INFO   Net.POP3.Account2 / disconnected  { error: null }
   *
   *
   * Promises
   * ----------------------------------------------------------------
   *
   * We live in an async world, full of Promises and false hopes.
   * Logic can wrap promises, making it easier to inspect async
   * control flow and generate graphs of Promise dependencies. Just
   * replace `new Promise(fn)` with `logic.promise(name, fn)`. This
   * works with child loggers too, of course.
   *
   * For instance:
   *
   *     return sublog.promise('open-account', (resolve, reject) => {
   *       // ...
   *     });
   *
   * With that one simple change, your logs contain structure that
   * would have otherwise been lost. With that information, we can
   * produce a visual graph of your code's execution flow, tracking
   * promises as they're resolved and deferred through time and space.
   *
   *
   * Using logs to assert expectations in tests
   * ----------------------------------------------------------------
   *
   * Logic makes writing tests easy. The following example is just a
   * chain of Promises:
   *
   *     // 1. Connect a new account.
   *     // 2. Fail if we see a log with the name 'offline'.
   *     // 3. Expect that we'll try to connect, and that the
   *     //    connection will fail with a 404 error.
   *     // 4. Disconnect.
   *
   *     var log = logic.follow();
   *     frontend((resolve, reject) => {
   *     }).then(backend((resolve, reject) => {
   *       log.match([
   *         'deleted'
   *       ]);
   *     }))
   *     events.match('foo', 'bar');
   * .     .then(() => {
   *         this.account = new Account();
   *         this.account.connect();
   *       })
   *       .rejectMatch('offline')
   *       .match('connecting')
   *       .match('connected', (details) => (details.error === 404))
   *       .then(() => {
   *         this.account.disconnect();
   *       })
   *       .catch((error) => {
   *         // "Error: expected ____ but saw ____."
   *       });
   *
   * Pretend `.match` and friends behave like `.then`, and the flow
   * should make sense. Since everything is a Promise, you can compose
   * these assertions any way you like. For more details on testing
   * with these match functions, see their docstrings.
   *
   *
   * Visualizing log output
   * ----------------------------------------------------------------
   *
   * Console logs are helpful, but we can do better, now that you've
   * expended all that effort naming and structuring your logs and
   * promises! Let's make that pile of data easy to understand:
   *
   *     var svg = logic.render();
   *
   */

  var evt = require('evt');
  var trackedPromises = new WeakMap();

  function merge(a, b) {
    var ret = {};
    for (var k in a) {
      ret[k] = a[k];
    }
    for (var k in b) {
      ret[k] = b[k];
    }
    return ret;
  }

  function Logic(eventConstructor) {
    this.eventConstructor = eventConstructor;
    evt.mix(this);
  }

  evt.mix(Logic);

  function eventWithDefaults(defaults) {
    return function(data) {
      return this.event(merge(defaults,
                              this.eventConstructor(data)));
    };
  }

  Logic.nextId = 0;

  Logic.prototype = {

    bind: function(defaults) {
      return new Logic((data) => merge(this.eventConstructor(defaults),
                                       this.eventConstructor(data)));
    },

    event: function(data) {
      var event = this.eventConstructor(data);
      event.time = window.performance.now();
      event.id = ++Logic.nextId;
      console.log("LOGIC", JSON.decycle(data), event);
      this.emit('event', event);
      Logic.emit('event', event);
      return event;
    },

    debug: eventWithDefaults({ level: 'debug' }),
    log: eventWithDefaults({ level: 'log' }),
    warn: eventWithDefaults({ level: 'warn' }),
    error: eventWithDefaults({ level: 'error' }),

    //----------------------------------------------------------------
    // Promises

    async: function(data, fn) {
      var startEvent;
      var promise = new Promise((resolve, reject) => {
        var asyncLogic = this.bind(data);
        startEvent = asyncLogic.event({ asyncType: 'async' });

        fn((result) => {
          promise.resultEvent = asyncLogic.event({
            asyncSources: [startEvent.id],
            asyncType: 'resolve',
            result: result
          });
          resolve(result);
        }, (error) => {
          promise.resultEvent = asyncLogic.event({
            asyncSources: [startEvent.id],
            asyncType: 'reject',
            error: error
          });
          reject(error);
        });
      });

      promise.id = startEvent.id;
      return promise;
    },

    await: function(data, promise) {
      var awaitLogic = this.bind(data);
      var awaitEvent = awaitLogic.event({
        asyncType: 'await',
        asyncSources: [promise.id]
      });
      return promise.then((result) => {
        awaitLogic.event({
          asyncType: 'then',
          asyncSources: [promise.resultEvent.id, awaitEvent.id],
          result: result
        });
        return result;
      }, (error) => {
        awaitLogic.event({
          asyncType: 'catch',
          asyncSources: [promise.resultEvent.id],
          error: error
        });
        throw error;
      });
    },

    firehose: function(fn) {
      Logic.on('event', event => { fn(event); });
    },

    follow: function() {
      var eventList = new LogicEventList(this);
      this.on('event', event => { eventList.add(event); });
      return eventList;
    }

  };

  // Via Douglas Crockford, Public Domain.
  JSON.decycle = function decycle(object) {
    var objects = [],   // Keep a reference to each unique object or array
        paths = [];     // Keep the path to each unique object or array
    return (function derez(value, path) {
      var i, name, nu;
      if (typeof value === 'object' && value !== null &&
          !(value instanceof Boolean) &&
          !(value instanceof Date)    &&
          !(value instanceof Number)  &&
          !(value instanceof RegExp)  &&
          !(value instanceof String)) {

        for (i = 0; i < objects.length; i += 1) {
          if (objects[i] === value) {
            return {$ref: paths[i]};
          }
        }

        objects.push(value);
        paths.push(path);

        if (Object.prototype.toString.apply(value) === '[object Array]') {
          nu = [];
          for (i = 0; i < value.length; i += 1) {
            nu[i] = derez(value[i], path + '[' + i + ']');
          }
        } else {
          nu = {};
          for (name in value) {
            if (Object.prototype.hasOwnProperty.call(value, name)) {
              nu[name] = derez(value[name],
                               path + '[' + JSON.stringify(name) + ']');
            }
          }
        }
        return nu;
      }
      return value;
    }(object, '$'));
  };

  function LogicEventList(logic, events) {
    this.logic = logic;
    this.events = events || [];
  }

  LogicEventList.prototype = {
    add: function(event) {
      this.events.push(event);
    },

    eventMatches: function(event, predicate) {
      if (typeof predicate === 'string') {
        return (this.type === predicate);
      } else if (Array.isArray(predicate)) {
        return predicate.every((p) => this.matches(p));
      } else if (typeof predicate === 'function') {
        return predicate(this);
      } else {
        for (var key in predicate) {
          if (this.details[key] !== predicate[key]) {
            return false;
          }
        }
        return true;
      }
    },

    match: function(predicates, options) {
      options = options || {};
      var wasPassedAnArray = Array.isArray(predicates);
      if (!wasPassedAnArray) {
        predicates = [predicates];
      }

      var matches = [];
      var mismatches = [];

      var i = 0, j = 0, inSequence = (options.exactly ? true : false);
      while(i < this.events.length && j < predicates.length) {
        var event = this.events[i];
        var predicate = predicates[j];
        if (this.eventMatches(event, predicate)) {
          this.logic.event({
            type: 'match',
            predicate: predicate,
            event: event
          });
          matches.push(event);
          j++; // Advance to the next predicate.
          i++; // This event only needs to match once.
          inSequence = true;
        } else if (options.consecutively && inSequence) {
          this.logic.event({
            type: 'mismatch',
            predicate: predicate,
            event: event
          });
          mismatches.push(new Mismatch(predicate, event));
          // We were hoping to see them in order, but failed.
        } else {
          i++;
        }
      }

      if (options.exactly) {
        while (i < this.events.length) {
          this.logic.event({
            type: 'mismatch',
            predicate: predicate,
            event: event
          });
          mismatches.push(new Mismatch(null, this.events[i++]));
        }
      }

      while (j < predicates.length) {
        this.logic.event({
          type: 'mismatch',
          predicate: predicate,
          event: event
        });
        mismatches.push(new Mismatch(predicates[j++], null));
      }

      if (mismatches.length) {
        var error = new Error(mismatches);
        error.mismatches = mismatches;
        throw error;
      } else {
        return wasPassedAnArray ? matches : matches[0];
      }
    }

  }

  function Mismatch(predicate, event) {
    this.predicate = predicate;
    this.event = event;
  }

  Mismatch.prototype.toString = function() {
    if (this.predicate && !this.event) {
      return 'Mismatch: didn\'t see ' + this.predicate;
    } else if (!this.predicate && this.event) {
      return 'Mismatch: extra event ' + this.event;
    } else {
      return ('Mismatch: expected predicate ' + this.predicate +
              ' to match event ' + this.event);
    }
  }




  // expose the root logger.
  return new Logic((data) => {
    if (typeof data === 'string') {
      return { type: data };
    } else {
      return data || {};
    }
  });
});

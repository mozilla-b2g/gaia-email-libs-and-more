define(function(require) {
  var evt = require('evt');
  var equal = require('equal');

  var trackedPromises = new WeakMap();

  function clone(obj) {
    if (isPlainObject(obj) || Array.isArray(obj)) {
      return JSON.parse(JSON.stringify(jsonDecycle(obj)));
    } else {
      return obj;
    }
  }

  function into(target, source) {
    if (!target) {
      target = {};
    }
    for (var key in source) {
      target[key] = source[key];
    }
    return target;
  }

  var nextId = 1;

  var emitter = new evt.Emitter();
  var objectToScope = new WeakMap();

  function toScope(scope) {
    if (!(scope instanceof Scope)) {
      scope = objectToScope.get(scope);
      if (!scope) {
        throw new Error('Invalid scope ' + scope +
                        ' passed to logic.event(); ' +
                        'did you remember to call logic.defineScope()? ' +
                        new Error().stack);
      }
    }
    return scope;
  }

  /**
   * The `logic` module is callable, as a shorthand for `logic.event()`.
   */
  function logic() {
    return logic.event.apply(logic, arguments);
  }

  /**
   * Create a new Scope with the given namespace and default details.
   *
   * @param {string} namespace
   * @param {object|null} defaultDetails
   */
  logic.scope = function(namespace, defaultDetails) {
      return new Scope(namespace, defaultDetails);
  };

  /**
   * Often, we don't want to track scopes explicitly -- most often,
   * scopes and namespaces map one-to-one with class instances. With
   * defineScope(), you can associate a Scope with an object, and then
   * use that object in place of the scope. For instance:
   *
   *   function MyClass() {
   *     logic.defineScope(this, 'MyClass');
   *     logic.event(this, 'initialized');
   *   }
   */
  logic.defineScope = function(obj, namespace, defaultDetails) {
    var scope = new Scope(namespace, defaultDetails);
    objectToScope.set(obj, scope);
    return scope;
  };

  /**
   * Sometimes, you may want to log several events, each with shared
   * details. With logic.subscope(), you can create a child scope that
   * shares the same namespace, but adds additional default details
   * onto each message. For instance:
   *
   *   logic.defineScope(this, 'Account', { accountId: 1 });
   *   var scope = logic.subscope(this, { action: 'move' });
   *   logic.log(scope, 'start');
   *   // event: Account/start { accountId: 1, action: 'move' }
   */
  logic.subscope = function(scope, defaultDetails) {
    scope = toScope(scope);
    return new Scope(scope.namespace, into(clone(scope.defaultDetails),
                                           clone(defaultDetails)));
  };

  /**
   * Emit an event. `logic(...)` is shorthand for `logic.event(...)`.
   * See the module docs for more about events.
   *
   * @param {Scope} scope
   *   The scope (i.e. "namespace") for this event.
   * @param {string} type
   *   A string, typically camelCased, describing the event taking place.
   * @param {object} details
   *   Optional details about this event, such as identifiers or parameters.
   *   These details will be mixed in with any default details specified
   *   by the Scope.
   * @param {string} humanStringTemplate
   *   An optional string which will be included in logging to assist
   *   with readability. Instances of "${key}" will be replaced by the
   *   value of the key in `details`. (TODO)
   */
  logic.event = function(scope, type, details, humanStringTemplate) {
    scope = toScope(scope);

    if (typeof type !== 'string') {
      throw new Error('Invalid "type" passed to logic.event(); ' +
                      'expected a string, got "' + type + '"');
    }

    if (scope.defaultDetails) {
      if(isPlainObject(details)) {
        details = into(clone(scope.defaultDetails), clone(details));
      } else {
        details = clone(scope.defaultDetails);
      }
    }

    var event = new LogicEvent(scope, type, details, humanStringTemplate);

    dump("EMIT " + event.type + '\n');
    emitter.emit(event.type, event);
    emitter.emit('*', event);

    return event;
  };

  logic.uniqueId = function() {
    return nextId++;
  };

  logic.shouldLogSensitiveData = function() {
    return false; //XXX
  };

  logic.realtimeLogEverything = function() {

  };

  logic.setSensitiveDataLoggingEnabled =  function(set) {

  };

  logic.on = function(type, fn) {
    emitter.on(type, fn);
  };

  logic.removeListener = function(type, fn) {
    emitter.removeListener(type, fn);
  };

  logic.follow = function() {
    var arr = new LogicEventArray();
    this.on('*', (event) => {
    });
  }

  var interceptions = {};

  logic.interceptable = function(type, fn) {
    if (interceptions[type]) {
      return interceptions[type]();
    } else {
      return fn();
    }
  };

  logic.interceptOnce = function(type, replacementFn) {
    var prevFn = interceptions[type];
    interceptions[type] = function() {
      interceptions[type] = prevFn;
      return replacementFn();
    };
  }







  function Scope(namespace, defaultDetails) {
    this.namespace = namespace;

    if (defaultDetails && !isPlainObject(defaultDetails)) {
      throw new Error('Invalid defaultDetails; expected a plain-old object.');
    }
    this.defaultDetails = defaultDetails;
  }

  function LogicEvent(scope, type, details, humanStringTemplate) {
    if (!(scope instanceof Scope)) {
      throw new Error('Invalid "scope" passed to LogicEvent(); ' +
                      'did you remember to call logic.defineScope()?');
    }

    this.scope = scope;
    this.type = type;
    this.details = details;
    this.humanStringTemplate = humanStringTemplate;
    this.time = window.performance.now();
  }

  LogicEvent.fromJSON = function(data) {
    var event = new LogicEvent(new Scope(data.namespace),
                               data.type,
                               data.details);
    event.time = data.time;
    event.id = data.id;
    event.humanStringTemplate = data.template;
    return event;
  }

  LogicEvent.prototype = {
    toJSON: function() {
      return {
        namespace: this.scope.namespace,
        type: this.type,
        details: jsonDecycle(this.details),
        time: this.time,
        template: this.humanStringTemplate,
        id: logic.uniqueId()
      }
    },

    matches: function(type, detailPredicate) {
      //console.log('MATCHES', this.type, type, JSON.stringify(this.details), JSON.stringify(detailPredicate));
      if (this.type !== type) {
        return false;
      }

      if (isPlainObject(detailPredicate)) {
        for (var key in detailPredicate) {
          var expected = detailPredicate && detailPredicate[key];
          var actual = this.details && this.details[key];
          if (actual === undefined) {
            actual = null; // For actual comparison, undefined equates to null.
          }

          if (expected === undefined) {
            continue; // We don't care about these.
          } else if (!this.details ||
                     !equal(expected, actual)) {
            return false;
          }
        }
        return true;
      } else if (typeof detailPredicate === 'function') {
        return !!detailPredicate(this.details);
      } else if (detailPredicate != null) {
        return equal(this.details, detailPredicate);
      } else {
        return true;
      }
    }
  };

  function isPlainObject(obj) {
    return obj && !Array.isArray(obj) &&
      typeof obj === 'object' && obj.prototype === undefined;
  }

    //----------------------------------------------------------------
    // // Promises

    // async: function(data, fn) {
    //   var startEvent;
    //   var promise = new Promise((resolve, reject) => {
    //     var asyncLogic = this.bind(data);
    //     startEvent = asyncLogic.event({ asyncType: 'async' });

    //     fn((result) => {
    //       promise.resultEvent = asyncLogic.event({
    //         asyncSources: [startEvent.id],
    //         asyncType: 'resolve',
    //         result: result
    //       });
    //       resolve(result);
    //     }, (error) => {
    //       promise.resultEvent = asyncLogic.event({
    //         asyncSources: [startEvent.id],
    //         asyncType: 'reject',
    //         error: error
    //       });
    //       reject(error);
    //     });
    //   });

    //   promise.id = startEvent.id;
    //   return promise;
    // },

    // await: function(data, promise) {
    //   var awaitLogic = this.bind(data);
    //   var awaitEvent = awaitLogic.event({
    //     asyncType: 'await',
    //     asyncSources: [promise.id]
    //   });
    //   return promise.then((result) => {
    //     awaitLogic.event({
    //       asyncType: 'then',
    //       asyncSources: [promise.resultEvent.id, awaitEvent.id],
    //       result: result
    //     });
    //     return result;
    //   }, (error) => {
    //     awaitLogic.event({
    //       asyncType: 'catch',
    //       asyncSources: [promise.resultEvent.id],
    //       error: error
    //     });
    //     throw error;
    //   });
    // },


  // Via Douglas Crockford, Public Domain.
  var jsonDecycle = function decycle(object) {
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


  // // logs: A B C D

  // logs
  //   .match('A')
  //   .match('C')
  // // <-- ['A', 'C']

  // logs.filterByNamespace('namespace')
  // logs.filterByNamespace('namespace')
  // logs.match(type, details)
  //   - returns the same instance, fast-forwarded to that event, if matched
  //   - throws error if not matched
  // logs
  //   .match('C')
  //   .match('A')

  // logs.match('init', { foo: 'bar' }) <-- every property must match, not identical,
  // // <-- Error: Expected to match 'A' after 'C'



  function LogicEventArray(events) {
    this.events = events || [];
    this.currentMatch = [];
  }

  LogicEventArray.prototype = {
    filterByNamespace: function(namespace) {
      return new LogicEventArray(this.events.filter((event) => {
        return event.scope.namespace === namespace;
      }));
    },

    match: function(type, detailPredicate) {
      var partialMatches = [];

      var index = -1;
      for (var i = 0; i < this.events.length; i++) {
        var event = this.events[i];
        if (event.type !== type) {
          continue;
        }

        partialMatches.push(event);

        if (event.matches(type, detailPredicate)) {
          index = i;
          break;
        }
      }

      if (index !== -1) {
        var ret = new LogicEventArray(this.events.slice(index + 1));
        ret.currentMatch.push(this.events[index]);
        return ret;
      } else {
        throw new Error('Mismatch: couldn\'t find an event with type=' +
                        type + ' and details=' + detailPredicate + '.' +
                        (partialMatches.length
                         ? (' We *did* see a log with type=' + type + ' ' +
                            'and details=' +
                            JSON.stringify(partialMatches[0].details) + '; ' +
                            'is that what you wanted?')
                         : ('')));
      }
    }
  }

  return logic;
});

/**
 * LegacyGelamTest: Supporting actor-style tests after it was cool.
 *
 * This docstring assumes familiarity with the old loggest/actor-based tests.
 *
 * In discussions about a new test architecture for GELAM, we wanted to overhaul
 * the logging mechanisms to be less finicky. However, we couldn't leave the
 * existing logs as they were: their strictness prevents us from adding new logs
 * to the existing system without breaking all the tests, and leaving them there
 * would cause us to have extra logs and unnecessary confusion.
 *
 * To reconcile this without losing too much test coverage, we've done the
 * following:
 *
 * 1. All old-style logs have been converted to use the 'logic' logging library,
 *    the successor to 'slog'. Most events mapped to the new system without
 *    any semantic changes.
 *
 *    NOTE: In refactoring this, we discovered that any LOGFAB argument defined
 *          as 'false' were not actually generating expectations. In at least
 *          a couple cases, the new tests check more arguments than before.
 *
 * 2. Actors have been simplified to include only the most essential methods:
 *
 *      eActor.expect(type, details)
 *      eActor.expectNot(type, details)
 *      eActor.log(type, details)
 *      eActor.useSetMatching()
 *
 *    All other "expect_*" functions have been removed.
 *
 * 3. Actors no longer care if they log extra events between the scope of their
 *    expectations. This was necessary to ensure that we can add new logs which
 *    share the same namespace without breaking all tests.
 *
 *    As seen above, useSetMatching() is still available and makes sense.
 *
 *    Risk: Medium-low. In theory, this means that we could regress behaviors
 *    that we previously checked. But because all of our existing test coverage
 *    is so thorough, we should be able to compensate for this as we write new
 *    tests and refactor older systems.
 *
 * 4. Test steps no longer care that actors are "active in a given step".
 *    Actors passed to test steps are ignored. Similarly,
 *    RT.reportActiveActorThisStep is now a no-op.
 *
 *      Risk: Low; this was a common source of errors and shouldn't affect
 *      test integrity.
 *
 * 5. Most T.{setup,check,...} functions are mapped to T.action.
 *
 * 6. This test file imports all of the old test helpers and hooks them up.
 *
 * Apart from coalescing some methods as described above, most existing tests
 * remained largely unchanged, and continue to pass and detect failures as
 * expected. All LegacyGelamTests can be viewed with the new logic-inspector
 * alongside new tests.
 */
define(function(require) {

  var logic = require('logic');
  var equal = require('equal');
  var GelamTest = require('./gelamtest');

  var $th_main = require('./th_main'),
      $th_fake_servers = require('tests/resources/th_fake_servers'),
      $th_contacts = require('tests/resources/th_contacts'),
      $th_devicestorage = require('tests/resources/th_devicestorage');

  var TEST_HELPERS = [
    $th_main.TESTHELPER,
    $th_fake_servers.TESTHELPER,
    $th_contacts.TESTHELPER,
    $th_devicestorage.TESTHELPER
  ];

  function Actor(T, RT, ns, name) {
    if (!ns) {
      ns = 'LazyActor';
    }
    this.T = T;
    this.RT = RT;
    this.__name = name;
    this.ns = ns;
    logic.defineScope(this, ns);
    this._resolveStep = null;
  }

  Actor.currentStepActors = null;

  Actor.prototype = {

    toString: function() {
      return '[' + this.ns + (this.__name ? ' ' + this.__name : '') + ']';
    },

    // Internal, you don't have to call this!
    ensureInStep: function() {
      if (!Actor.currentStepActors) {
        throw new Error('Actor ' + this + ' is not in a step!');
      }
      if (!Actor.currentStepActors.has(this)) {
        this.setMatchingEnabled = false;
        this.unmetExpectations = [];
        this.shouldNotHaveMetExpectations = [];
        this.notExpectations = [];
        Actor.currentStepActors.add(this);
      }
    },

    expectNot: function(type, details) {
      this.ensureInStep();
      var expectation = { not: true, type: type, details: details };
      logic(this, 'expectNot', expectation);
      this.notExpectations.push(expectation);
    },

    expect: function(type, details) {
      this.ensureInStep();
      var expectation = { type: type, details: details };
      logic(this, 'expect', expectation);
      this.unmetExpectations.push(expectation);
    },

    error: function(msg) {
      this.ensureInStep();
      this.shouldNotHaveMetExpectations.push(msg);
    },

    useSetMatching: function() {
      this.ensureInStep();
      this.setMatchingEnabled = true;
    },

    log: function(name, details) {
      logic(this, name, details);
    },

    handleEvent: function(event) {
      if (event.scope.namespace !== this.ns) {
        return;
      }

      for (var i = 0; i < this.notExpectations.length; i++) {
        var expectation = this.notExpectations[i];
        if (event.matches(expectation.type, expectation.details)) {
          this.shouldNotHaveMetExpectations.push(expectation);
          break;
        }
      }

      if (this.setMatchingEnabled) {
        for (var i = 0; i < this.unmetExpectations.length; i++) {
          var expectation = this.unmetExpectations[i];
          if (event.matches(expectation.type, expectation.details)) {
            logic(this, 'match', expectation);
            this.unmetExpectations.splice(i, 1);
            break;
          }
        }
      } else {
        var expectation = this.unmetExpectations[0];
        if (expectation &&
            event.matches(expectation.type, expectation.details)) {
          logic(this, 'match', expectation);
          this.unmetExpectations.shift();
        }
      }
    },

  };

  function LegacyGelamTest(name, options, fn) {
    if (typeof options === 'function') {
      fn = options;
      options = {};
    }

    options.legacy = true;

    this.legacyFn = fn;
    GelamTest.call(this, name, options, () => {
      return this.init();
    });
  }

  LegacyGelamTest.prototype = Object.create(GelamTest.prototype);

  var fileBlackboard = {};

  LegacyGelamTest.prototype.init = function() {

    this.actors = [];
    this.steps = [];
    this.deferredSteps = [];

    logic.defineScope(this, 'LegacyGelamTest');
    var scope = this;

    var T = {
      group: (name) => {
        T.action(name, function() {
        });
      },

      action: () => {
        var stepFn = arguments[arguments.length - 1];
        var name = '';
        for (var i = 0; i < arguments.length - 1; i++) {
          name += arguments[i] + ' ';
        }
        stepFn.stepName = name;
        this.steps.push(stepFn);
        return stepFn;
      },

      lazyLogger: (name) => {
        return T.actor(name);
      },

      thing: (type, specificName) => {
        return T.actor(type, specificName);
      },

      actor: (type, shortName, actorOptions) => {
        var actor = new Actor(T, RT, type, shortName);
        TEST_HELPERS.forEach((helper) => {
          var mixin = helper.actorMixins[type];
          if (mixin) {
            for (var key in mixin) {
              actor[key] = mixin[key];
            }
          }
        });

        if ("__constructor" in actor) {
          actor.__constructor(actor, actorOptions);
        }

        this.actors.push(actor);

        return actor;
      }
    };

    T.convenienceSetup = T.action;
    T.setup = T.action;
    T.check = T.action;
    T.cleanup = T.action;
    T.convenienceDeferredCleanup = function() {
      T.action.apply(T, arguments);
      this.deferredSteps.push(this.steps.pop());
    }.bind(this);

    var RT = {
      envOptions: this.options,
      fileBlackboard: fileBlackboard,
      reportActiveActorThisStep: function() { }
    };

    // Instantiate the actors and steps by running the test body.
    this.legacyFn(T, RT);

    var executeNextStep = () => {
      var stepFn = this.steps.shift() || this.deferredSteps.shift();
      if (!stepFn) {
        // logic(scope, 'All steps done');
        return null;
      }

      return Promise.resolve()
        .then(() => {
          logic(scope, 'step-begin', { name: stepFn.stepName,
                                       timeout: stepFn.timeoutMS });

          // Wait for all actors to meet their expectations, or for
          // the step to time out.
          return new Promise((resolve, reject) => {
            var timeoutId = setTimeout(function() {
              var firstError = null;
              Actor.currentStepActors.forEach((actor) => {
                actor.shouldNotHaveMetExpectations.forEach((expectation) => {
                  if (!firstError) {
                    firstError = 'Should Not Have Met Expectation: ' +
                      JSON.stringify(expectation);
                  }
                  logic(scope, 'failed-expectation',
                        actor.ns + ': ' + JSON.stringify(expectation));
                });
                actor.unmetExpectations.forEach((expectation) => {
                  if (!firstError) {
                    firstError = 'Failed Expectation: ' +
                      JSON.stringify(expectation);
                  }
                  logic(scope, 'failed-expectation',
                        actor.ns + ': ' + JSON.stringify(expectation));
                });
              });
              logic.removeListener('event', eventListener);
              reject(firstError || 'timeout');
            }, stepFn.timeoutMS || 5000);

            var stepDefined = false;

            var eventListener = function(event) {
              var allActorsDone = stepDefined ? true : false;

              // Pass each logged event to the current actors.
              Actor.currentStepActors.forEach((actor) => {
                if (event) {
                  actor.handleEvent(event);
                }
                if (actor.unmetExpectations.length) {
                  allActorsDone = false;
                }
              });

              // If all actors have fulfilled their expectations,
              // we can finish the current step.
              if (allActorsDone) {
                clearTimeout(timeoutId);
                logic.removeListener('event', eventListener);
                resolve();
              }
            };

            Actor.currentStepActors = new Set();

            logic.on('event', eventListener);

            // Execute the current step.
            stepFn();

            stepDefined = true;

            // If no actors are expecting anything, the end of the
            // step won't be signaled by an event. Trigger the check
            // now to address that case.
            eventListener(null);
          });
        }).then(() => {
          Actor.currentStepActors = null;
          logic(scope, 'step-end', { name: stepFn.stepName });
          return Promise.resolve().then(executeNextStep);
        }).catch((error) => {
          logic(scope, 'error', { error: error + '', stack: error.stack });
          logic(scope, 'step-end', { name: stepFn.stepName,
                                     error: error });
          Actor.currentStepActors = null;
          throw error;
        });
    }

    var promise = Promise.resolve();
    return promise.then(executeNextStep);
  }

  return LegacyGelamTest;

});

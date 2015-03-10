define(function(require) {

  var logic = require('logic');
  var equal = require('equal');
  var GelamTest = require('./gelamtest');

  var $th_main = require('./th_main'),
      $th_fake_imap_server = require('tests/resources/th_fake_imap_server'),
      $th_fake_pop3_server = require('tests/resources/th_fake_pop3_server'),
      $th_real_imap_server = require('tests/resources/th_real_imap_server'),
      $th_fake_as_server = require('tests/resources/th_fake_activesync_server'),
      $th_contacts = require('tests/resources/th_contacts'),
      $th_devicestorage = require('tests/resources/th_devicestorage');

  var TEST_HELPERS = [
    $th_main.TESTHELPER,
    $th_fake_as_server.TESTHELPER,
    $th_fake_imap_server.TESTHELPER,
    $th_fake_pop3_server.TESTHELPER,
    $th_real_imap_server.TESTHELPER,
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

    ensureInStep: function() {
      if (!Actor.currentStepActors) {
        throw new Error('Actor ' + this + ' is not in a step!');
      }
      if (!Actor.currentStepActors.has(this)) {
        this.setMatchingEnabled = false;
        this.unmetExpectations = [];
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
      console.error(msg);
      this.unmetExpectations.push(msg);
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
          this.unmetExpectations.push(expectation);
          break;
        }
      }

      if (this.setMatchingEnabled) {
        for (var i = 0; i < this.unmetExpectations.length; i++) {
          var expectation = this.unmetExpectations[i];
          if (event.matches(expectation.type, expectation.details)) {
            this.unmetExpectations.splice(i, 1);
            break;
          }
        }
      } else {
        var expectation = this.unmetExpectations[0];
        if (expectation &&
            event.matches(expectation.type, expectation.details)) {
          this.unmetExpectations.shift();
        }
      }
    },

  };

  function LegacyGelamTest(name, opts, fn) {
    if (typeof opts === 'function') {
      fn = opts;
      opts = {};
    }

    this.legacyFn = fn;
    GelamTest.call(this, name, opts, () => {
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
        T.action(function() {
          logic(scope, 'group', { name: name });
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
      envOptions: this.envOptions,
      fileBlackboard: fileBlackboard,
      reportActiveActorThisStep: function() { }
    };

    // Instantiate the actors and steps by running the test body.
    this.legacyFn(T, RT);

    var executeNextStep = () => {
      var stepFn = this.steps.shift() || this.deferredSteps.shift();
      if (!stepFn) {
        logic(scope, 'All steps done');
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
              Actor.currentStepActors.forEach((actor) => {
                actor.unmetExpectations.forEach((expectation) => {
                  console.error('Unmet expectation:',
                                actor.ns, JSON.stringify(expectation));
                });
              });
              logic.removeListener('*', eventListener);
              reject('timeout');
            }, stepFn.timeoutMS || 1000);

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
                logic.removeListener('*', eventListener);
                resolve();
              }
            };

            Actor.currentStepActors = new Set();

            logic.on('*', eventListener);

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
          Actor.currentStepActors = null;
          throw error;
        });
    }

    var promise = Promise.resolve();
    return promise.then(executeNextStep);
  }

  return LegacyGelamTest;

});

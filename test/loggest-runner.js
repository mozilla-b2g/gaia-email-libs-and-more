/**
 *
 **/
define(
  [
    'q',
    'mailapi/shim-sham', // needed for global mocks
    'rdcommon/testdriver',
    'require'
  ],
  function(
    $Q,
    $shimsham,
    $td,
    require
  ) {

function consoleHelper() {
  var msg = arguments[0] + ':';
  for (var i = 1; i < arguments.length; i++) {
    msg += ' ' + arguments[i];
  }
  msg += '\x1b[0m\n';
  dump(msg);
}
var pconsole = {
  log: consoleHelper.bind(null, '\x1b[32mLOG'),
  error: consoleHelper.bind(null, '\x1b[31mERR'),
  info: consoleHelper.bind(null, '\x1b[36mINF'),
  warn: consoleHelper.bind(null, '\x1b[33mWAR')
};


function getEnv(locSource) {
  if (locSource === undefined)
    locSource = window;
  var env = {};

console.warn('locSource.location.href', locSource.location.href);
console.warn('locSource.location.search', locSource.location.search);

  var searchBits = locSource.location.search.substring(1).split("&");
  for (var i = 0; i < searchBits.length; i++) {
    var searchBit = searchBits[i];
    // skip things without a payload.
    if (searchBit.indexOf("=") <= 0)
      continue;
    var pair = searchBit.split("=", 2);
    var key = decodeURIComponent(pair[0]);
    var value = decodeURIComponent(pair[1]);
    env[key] = value;
  }

  return env;
};

var SUPER_DEBUG = consoleHelper.bind(null, '\x1b[35mTEST');

var ErrorTrapper = {
  _trappedErrors: null,
  _handlerCallback: null,
  /**
   * Express interest in errors.
   */
  trapErrors: function() {
    this._trappedErrors = [];
  },
  callbackOnError: function(handler) {
    this._handlerCallback = handler;
    this._trappedErrors = [];
  },
  yoAnError: function(err, moduleName) {
    if (this._trappedErrors == null || SUPER_DEBUG) {
      console.error("==== REQUIREJS ERR ====", moduleName);
      console.error(err.message);
      console.error(err.stack);
    }
    if (this._handlerCallback)
      this._handlerCallback(err, moduleName);
    else if (this._trappedErrors)
      this._trappedErrors.push(err);
  },
  gobbleAndStopTrappingErrors: function() {
    this._handlerCallback = null;
    var errs = this._trappedErrors;
    this._trappedErrors = null;
    return errs;
  },

  _listenerMap: {
    exit: null,
    uncaughtException: null,
  },
  on: function(name, listener) {
    this._listenerMap[name] = listener;
  },
  once: function(name, listener) {
    this._listenerMap[name] = function(data) {
      listener(data);
      ErrorTrapper.removeListener(name);
    };
  },
  removeListener: function(name) {
    this._listenerMap[name] = null;
  },
  reliableOutput: print,

  fire: function(name, data) {
    if (!this._listenerMap[name])
      return;
    console.log('firing', name, data);
    this._listenerMap[name](data);
  },

};
window.ErrorTrapper = ErrorTrapper;
requirejs.onError = ErrorTrapper.yoAnError.bind(ErrorTrapper);

var env = getEnv();

// does not include a trailing '.js'!
var testModuleName = 'tests/' + env.testName;
console.log('requiring module:', testModuleName);
var testParams = env.testParams ? JSON.parse(env.testParams) : {};
console.warn('fakeParent?', window.parent.fakeParent);
$td.runTestsFromModule(
  testModuleName,
  {
    exposeToTest: testParams,
    resultsReporter: function(jsonnableObj) {
      console.log('Got results! posting message. fake parent?:',
                  window.parent.fakeParent);
      // Save off the log just in case there was a race about clobbering
      // window.parent.
      window.logResultsMsg = {
        type: 'loggest-test-results',
        data: jsonnableObj
      };

      window.parent.postMessage(window.logResultsMsg, '*');
    }
  },
  ErrorTrapper,
  SUPER_DEBUG);

}); // end define

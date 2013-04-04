/**
 *
 **/
define(
  [
    'q',
    'mailapi/shim-sham', // needed for global mocks
    'mailapi/worker-router',
    'rdcommon/testdriver',
    'require'
  ],
  function(
    $Q,
    $shimsham,
    $router,
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
  log: consoleHelper.bind(null, '\x1b[32mWLOG'),
  error: consoleHelper.bind(null, '\x1b[31mWERR'),
  info: consoleHelper.bind(null, '\x1b[36mWINF'),
  warn: consoleHelper.bind(null, '\x1b[33mWWAR')
};

var SUPER_DEBUG = consoleHelper.bind(null, '\x1b[35mWTEST');

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

  fire: function(name, data) {
    if (!this._listenerMap[name])
      return;
    console.log('firing', name, data);
    this._listenerMap[name](data);
  },

};
window.ErrorTrapper = ErrorTrapper;
requirejs.onError = ErrorTrapper.yoAnError.bind(ErrorTrapper);


var sendMessage = $router.registerSimple('loggest-runner', function(msg) {
  var cmd = msg.cmd, args = msg.args;
  console.log('GOT', JSON.stringify(args));
  if (cmd === 'run') {
    console.log('requiring module:', args.testModuleName);
    $td.runTestsFromModule(
      args.testModuleName,
      {
        exposeToTest: msg.args.testParams,
        resultsReporter: function(jsonnableObj) {
          sendMessage('done', JSON.stringify(jsonnableObj));
        }
      },
      ErrorTrapper,
      SUPER_DEBUG);
  }
  else if (cmd === 'error') {
    ErrorTrapper.yoAnError(args);
  }
});

console.log('sending "ready" message');
sendMessage('ready');

}); // end define

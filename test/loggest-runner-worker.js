/**
 *
 **/
define(
  [
    'gelam/worker-router',
    'rdcommon/testdriver',
    'require'
  ],
  function(
    $router,
    $td,
    require
  ) {

var SUPER_DEBUG = makeConsoleFunc('\x1b[35mWTEST').bind(window.console);

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
  var cmd = msg.cmd, args = msg.args, superDebug = null;
  console._enabled = args.testParams.testLogEnable;
  console.log('GOT', JSON.stringify(args));
  if (cmd === 'run') {
    console.log('requiring module:', args.testModuleName);

    if (args.testParams.testLogEnable) {
      superDebug = SUPER_DEBUG;
    }

    $td.runTestsFromModule(
      args.testModuleName,
      {
        exposeToTest: msg.args.testParams,
        resultsReporter: function(jsonnableObj) {
          sendMessage('done', JSON.stringify(jsonnableObj));
          //self.close();
        }
      },
      ErrorTrapper,
      superDebug);
  }
  else if (cmd === 'error') {
    ErrorTrapper.yoAnError(args);
  }
});

console.log('sending "ready" message');
sendMessage('ready');

}); // end define

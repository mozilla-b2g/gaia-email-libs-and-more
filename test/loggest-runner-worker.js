define(
  [
    'gelam/worker-router',
    'require'
  ],
  function(
    $router,
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

    var currentGelamTest;
    var testLogs = [];
    // Error Handling

    function handleUncaught(ex) {
      console.error('Uncaught Exception:', ex);
    }
    function handleEarlyExit() {
      console.error('EVENT LOOP TERMINATING IMPLYING BAD TEST!');
      if (currentGelamTest) {
        testLogs.push(currentGelamTest.gatherLogs('early exit'));
        sendMessage('done', JSON.stringify(testLogs));
      }
    }

    ErrorTrapper.on('uncaughtException', handleUncaught);
    ErrorTrapper.once('exit', handleEarlyExit);
    ErrorTrapper.callbackOnError((err, moduleName) => {
      console.error('RequireJS Error', err, moduleName);
    });

    var removeErrorTraps = function() {
      ErrorTrapper.removeListener('uncaughtException', handleUncaught);
      ErrorTrapper.removeListener('exit', handleEarlyExit);
    };

    require([args.testModuleName], function(testArray) {
      if (!Array.isArray(testArray)) {
        testArray = [testArray];
      }

      var promise = Promise.resolve();
      testArray.forEach((gelamTest) => {
        promise = promise.then(() => {
          return gelamTest.run(msg.args.testParams);
        }).then((resultsJson) => {
          testLogs.push(resultsJson);
        });
      });
      promise = promise.then(() => {
        removeErrorTraps();
        sendMessage('done', JSON.stringify(testLogs));
      });
    });
  }
  else if (cmd === 'error') {
    ErrorTrapper.yoAnError(args);
  }
});

console.log('sending "ready" message');
sendMessage('ready');

}); // end define

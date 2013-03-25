/**
 *
 **/
define(
  [
    'q',
    'mailapi/shim-sham', // needed for global mocks
    'mailapi/worker-support/main-router',
    // XXX Ideally we would only load this at the request of the test, but
    // there's no real harm in always spinning this up for now.
    'mailapi/worker-support/testhelper-main',
    'rdcommon/testdriver',
    'require'
  ],
  function(
    $Q,
    $shimsham,
    $router,
    $th_main,
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
  log: consoleHelper.bind(null, '\x1b[32mMLOG'),
  error: consoleHelper.bind(null, '\x1b[31mMERR'),
  info: consoleHelper.bind(null, '\x1b[36mMINF'),
  warn: consoleHelper.bind(null, '\x1b[33mMWAR')
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

var env = getEnv();

// does not include a trailing '.js'!
var testModuleName = 'tests/' + env.testName;
var testParams = env.testParams ? JSON.parse(env.testParams) : {};

var loggestRouterModule = {
  name: 'loggest-runner',
  sendMessage: null,
  process: function(uid, cmd, args) {
    if (cmd === 'ready') {
      console.log('Got ready message, sending test information back.');
      this.sendMessage(
        null, 'run',
        {
          testModuleName: testModuleName,
          testParams: testParams
        });
    }
    else if (cmd === 'done') {
       console.log('Got results! posting message. fake parent?:',
                   window.parent.fakeParent);
      // Save off the log just in case there was a race about clobbering
      // window.parent.
      window.logResultsMsg = {
        type: 'loggest-test-results',
        data: args
      };

      window.parent.postMessage(window.logResultsMsg, '*');
    }
  }
};
$router.register(loggestRouterModule);

requirejs.onError = function rjsError(err) {
  console.warn('relaying error:', err);
  loggestRouterModule.sendMessage(
    null, 'error',
    { name: err.name, message: err.message, stack: err.stack });
};

var worker = new Worker('/test/worker-bootstrap.js');
$router.useWorker(worker);

}); // end define

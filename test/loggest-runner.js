/**
 *
 **/
define(
  [
    'gelam/worker-support/main-router',
    // XXX Ideally we would only load this at the request of the test, but
    // there's no real harm in always spinning this up for now.
    'gelam/worker-support/testhelper-main',
    'rdcommon/testdriver',
    'require'
  ],
  function(
    $router,
    $th_main,
    $td,
    require
  ) {

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
}

var env = getEnv();

// does not include a trailing '.js'!
var testModuleName = 'tests/' + env.testName;
var testParams = env.testParams ? JSON.parse(env.testParams) : {};

console._enabled = testParams.testLogEnable;

var loggestRouterModule = {
  name: 'loggest-runner',
  sendMessage: null,
  process: function(uid, cmd, args) {
    if (cmd === 'ready') {
      console.log('Got ready message, sending test information back,');
      this.sendMessage(
        null, 'run',
        {
          testModuleName: testModuleName,
          testParams: testParams,
        });
    }
    else if (cmd === 'done') {
      console.log('Got results! posting message.');

      console.log('waiting for the worker to kill itself.');

      setTimeout(function() {
        console.log('actually posting the kill-me now');

        var logResultsMsg = {
          type: 'loggest-test-results',
          data: args
        };

        window.postMessage(logResultsMsg, '*');
      }, 100);
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

/**
 * This file just exists to require the given script dynamically.
 **/
define(
  [
    'gelam/main-frame-setup',
    'require'
  ],
  function(
    MailAPI,
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
var scriptModuleName = 'test/scripts/' + env.testName;
var scriptParams = env.testParams ? JSON.parse(env.testParams) : {};

console._enabled = true;

console.log('about to require', scriptModuleName);
require([scriptModuleName], function(scriptMain) {

  function allDone() {
    window.postMessage(
      {
        type: 'script-done',
      }, '*');
  }
  scriptMain(scriptParams, MailAPI).then(allDone, allDone);
});

}); // end define

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Instantiates the IMAP Client in the same webpage as the UI and provides the
 * bridge hookup logic.
 **/

define(
  [
    './shim-sham',
    'rdcommon/log',
    'rdcommon/logreaper',
    './mailapi',
    './mailbridge',
    './mailuniverse',
    './imapslice',
    'exports'
  ],
  function(
    $shim_setup,
    $log,
    $logreaper,
    $mailapi,
    $mailbridge,
    $mailuniverse,
    $imapslice,
    exports
  ) {
'use strict';

function createBridgePair(universe) {
  var TMB = new $mailbridge.MailBridge(universe);
  var TMA = new $mailapi.MailAPI();
  // shim-sham provide window.setZeroTimeout
  TMA.__bridgeSend = function(msg) {
    window.setZeroTimeout(function() {
      TMB.__receiveMessage(msg);
    });
  };
  TMB.__sendMessage = function(msg) {
    window.setZeroTimeout(function() {
      TMA.__bridgeReceive(msg);
    });
  };
  return {
    api: TMA,
    bridge: TMB
  };
}

var _universeCallbacks = [], localMailAPI = null;
function onUniverse() {
  localMailAPI = createBridgePair(universe).api;
  console.log("Mail universe/bridge created, notifying.");
  for (var i = 0; i < _universeCallbacks.length; i++) {
    _universeCallbacks[i](universe);
  }
  _universeCallbacks = null;
  var evtObject = document.createEvent('Event');
  evtObject.initEvent('mailapi', false, false);
  evtObject.mailAPI = localMailAPI;
  window.dispatchEvent(evtObject);
}
/**
 * Should the logging subsystem run at unit-test levels of detail (which means
 * capturing potential user data like the contents of e-mails)?  The answer
 * is NEVER BY DEFAULT and ALMOST NEVER THE REST OF THE TIME.
 *
 * The only time we would want to turn this on is when detailed debugging is
 * required, we have data censoring in place for all super-sensitive data like
 * credentials (we have it for IMAP, but not SMTP, although it's not logging
 * right now), there is express user consent, and we have made a reasonable
 * level of effort to create automated tooling that can extract answers from
 * the logs in an oracular fashion so that the user doesn't need to provide
 * us with the logs, but can instead have our analysis code derive answers.
 */
const DANGEROUS_LOG_EVERYTHING = false;
var universe = new $mailuniverse.MailUniverse(DANGEROUS_LOG_EVERYTHING,
                                              onUniverse);
var LOG_REAPER, LOG_BACKLOG = [], MAX_LOG_BACKLOG = 60;
LOG_REAPER = new $logreaper.LogReaper(universe._LOG);

function runOnUniverse(callback) {
  if (_universeCallbacks !== null) {
    _universeCallbacks.push(callback);
    return;
  }
  callback(universe);
}
window.gimmeMailAPI = function(callback) {
  runOnUniverse(function() {
    callback(localMailAPI);
  });
};

/**
 * Debugging: enable spawning a loggest log browser using our log contents;
 * call document.spawnLogWindow() to do so.
 */
document.enableLogSpawner = function enableLogSpawner(spawnNow) {
  var URL = "http://localhost/live/arbpl/client/index-post-devmode.html",
      ORIGIN = "http://localhost";

  var openedWin = null,
      channelId = null,
      spamIntervalId = null;
  document.spawnLogWindow = function() {
    // not security, just naming.
    channelId = 'arbpl' + Math.floor(Math.random() * 1000000) + Date.now();
    // name the window so we can reuse it
    openedWin = window.open(URL + '#' + channelId, "ArbPL");
    spamIntervalId = setInterval(spammer, 100);
  };
  // Keep pinging the window until it tells us it has fully loaded.
  function spammer() {
    openedWin.postMessage({ type: 'hello', id: channelId }, ORIGIN);
  }
  window.addEventListener("message", function(event) {
    if (event.origin !== ORIGIN)
      return;
    if (event.data.id !== channelId)
      return;
    clearInterval(spamIntervalId);

    event.source.postMessage(
      {
        type: "backlog",
        id: channelId,
        schema: $log.provideSchemaForAllKnownFabs(),
        backlog: LOG_BACKLOG,
      },
      event.origin);
  }, false);

  if (spawnNow)
    document.spawnLogWindow();
};

////////////////////////////////////////////////////////////////////////////////
// Logging

// once a second, potentially generate a log
setInterval(function() {
  if (!LOG_REAPER)
    return;
  var logTimeSlice = LOG_REAPER.reapHierLogTimeSlice();
  // if nothing interesting happened, this could be empty, yos.
  if (logTimeSlice.logFrag) {
    LOG_BACKLOG.push(logTimeSlice);
    // throw something away if we've got too much stuff already
    if (LOG_BACKLOG.length > MAX_LOG_BACKLOG)
      LOG_BACKLOG.shift();

    // In deuxdrop, this is where we would also update our subscribers.  We
    // may also want to do that here.
  }
}, 1000);

////////////////////////////////////////////////////////////////////////////////

});

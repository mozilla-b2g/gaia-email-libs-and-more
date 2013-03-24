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
    './mailbridge',
    './mailuniverse',
    'exports'
  ],
  function(
    $shim_setup,
    $mailbridge,
    $mailuniverse,
    exports
  ) {
'use strict';

var bridgeUniqueIdentifier = 0;
function createBridgePair(universe) {
  var uid = bridgeUniqueIdentifier++;

  var TMB = new $mailbridge.MailBridge(universe);

  self.addEventListener('message', function(evt) {
    var data = evt.data;
    if (data.type != 'bridge' || data.uid != uid)
      return;

    //dump("MailBridge receiveMessage: " + JSON.stringify(data) + "\n");
    TMB.__receiveMessage(data.msg);
  });

  TMB.__sendMessage = function(msg) {
    TMB._LOG.send(msg.type, msg);
    self.postMessage({
      uid: uid,
      type: 'bridge',
      msg: msg
    });
  };

  // Let's say hello to the main thread in order to generate a 
  // corresponding mailAPI.
  TMB.__sendMessage({
    type: 'hello',
    config: universe.exposeConfigForClient()
  });
}

function onUniverse() {
  createBridgePair(universe);
  console.log("Mail universe/bridge created and notified!");
}

var universe = null;
self.addEventListener('message', function(evt) {
  var data = evt.data;
  if (data.type != 'hello') {
    return;
  }
  //dump("WorkerListener: same-frame-setup.js: " + JSON.stringify(data) + "\n");
  var args = data.args;
  switch (data.cmd) {
    case 'hello':
      navigator.onLine = args[0];
      navigator.hasPendingAlarm = args[1];

      universe = new $mailuniverse.MailUniverse(onUniverse);
      break;

    case 'online':
    case 'offline':
      navigator.onLine = args[0];
      break;
  }
});
self.postMessage({ type: "hello" });

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

if ('document' in this) {
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
      universe.createLogBacklogRep(channelId),
      event.origin);
  }, false);

  if (spawnNow)
    document.spawnLogWindow();
};

}

////////////////////////////////////////////////////////////////////////////////

});

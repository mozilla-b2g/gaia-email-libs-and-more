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

  window.addEventListener('message', function(evt) {
    var data = evt.data;
    if (data.type != 'bridge' || data.uid != uid)
      return;

    //dump("MailBridge receiveMessage: " + JSON.stringify(data) + "\n");
    TMB.__receiveMessage(data.msg);
  });

  TMB.__sendMessage = function(msg) {
    TMB._LOG.send(msg.type, msg);
    window.postMessage({
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
window.addEventListener('message', function(evt) {
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
window.postMessage({ type: "hello" });

////////////////////////////////////////////////////////////////////////////////

});

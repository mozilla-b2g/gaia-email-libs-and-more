/**
 * The startup process (which can be improved) looks like this:
 *
 * Main: Initializes worker support logic
 * Main: Spawns worker
 * Worker: Loads core JS
 * Worker: 'hello' => main
 * Main: 'hello' => worker with online status and mozAlarms status
 * Worker: Creates MailUniverse
 * Worker 'mailbridge'.'hello' => main
 * Main: Creates MailAPI, sends event to UI
 * UI: can really do stuff
 *
 * Note: this file is not currently used by the GELAM unit tests;
 * mailapi/testhelper.js (in the worker) and
 * mailapi/worker-support/testhelper-main.js establish the (bounced) bridge.
 **/

define(
  [
    // Pretty much everything could be dynamically loaded after we kickoff the
    // worker thread.  We just would need to be sure to latch any received
    // messages that we receive before we finish setup.
    './worker-support/shim-sham',
    './mailapi',
    './worker-support/main-router',
    './worker-support/configparser-main',
    './worker-support/cronsync-main',
    './worker-support/devicestorage-main',
    './worker-support/maildb-main',
    './worker-support/net-main'
  ],
  function(
    $shim_setup,
    $mailapi,
    $router,
    $configparser,
    $cronsync,
    $devicestorage,
    $maildb,
    $net
  ) {

  var worker;
  function init() {
    // Do on a timeout to allow other startup logic to complete without
    // this code interfering
    setTimeout(function() {
      worker = new Worker('js/ext/mailapi/worker-bootstrap.js');

      $router.useWorker(worker);

      $router.register(control);
      $router.register(bridge);
      $router.register($configparser);
      $router.register($cronsync);
      $router.register($devicestorage);
      $router.register($maildb);
      $router.register($net);
    });
  }

  var control = {
    name: 'control',
    sendMessage: null,
    process: function(uid, cmd, args) {
      var online = navigator.onLine;
      var hasPendingAlarm = navigator.mozHasPendingMessage &&
                            navigator.mozHasPendingMessage('alarm');
      control.sendMessage(uid, 'hello', [online, hasPendingAlarm]);

      window.addEventListener('online', function(evt) {
        control.sendMessage(uid, evt.type, [true]);
      });
      window.addEventListener('offline', function(evt) {
        control.sendMessage(uid, evt.type, [false]);
      });
      if (navigator.mozSetMessageHandler) {
        navigator.mozSetMessageHandler('alarm', function(msg) {
          control.sendMessage(uid, 'alarm', [msg]);
        });
      }

      $router.unregister(control);
    },
  };


  // Create a purposely global MailAPI, and indicate it is fake for
  // now, waiting on real back end to boot up.
  MailAPI = new $mailapi.MailAPI();
  MailAPI._fake = true;

  var bridge = {
    name: 'bridge',
    sendMessage: null,
    process: function(uid, cmd, args) {
      var msg = args;

      if (msg.type === 'hello') {
        delete MailAPI._fake;
        MailAPI.__bridgeSend = function(msg) {
          worker.postMessage({
            uid: uid,
            type: 'bridge',
            msg: msg
          });
        };

        MailAPI.config = msg.config;

        // Send up all the queued messages to real backend now.
        MailAPI._storedSends.forEach(function (msg) {
          MailAPI.__bridgeSend(msg);
        });
        MailAPI._storedSends = [];
      } else {
        MailAPI.__bridgeReceive(msg);
      }
    },
  };

  init();
}); // end define

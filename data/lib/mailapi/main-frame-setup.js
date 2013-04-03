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
    worker = new Worker('js/ext/mailapi/worker-bootstrap.js');

    $router.useWorker(worker);

    $router.register(control);
    $router.register(bridge);
    $router.register($configparser);
    $router.register($cronsync);
    $router.register($devicestorage);
    $router.register($maildb);
    $router.register($net);
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


  var mailAPI;
  var bridge = {
    name: 'bridge',
    sendMessage: null,
    process: function(uid, cmd, args) {
      var msg = args;

      if (msg.type === 'hello') {
        mailAPI = new $mailapi.MailAPI();
        mailAPI.__bridgeSend = function(msg) {
          worker.postMessage({
            uid: uid,
            type: 'bridge',
            msg: msg
          });
        };

        mailAPI.config = msg.config;

        var evtObject = document.createEvent('Event');
        evtObject.initEvent('mailapi', false, false);
        evtObject.mailAPI = mailAPI;
        window.dispatchEvent(evtObject);
      } else {
        mailAPI.__bridgeReceive(msg);
      }
    },
  };

  init();
}); // end define

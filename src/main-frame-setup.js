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

import logic from 'logic';

// Pretty much everything could be dynamically loaded after we kickoff the
// worker thread.  We just would need to be sure to latch any received
// messages that we receive before we finish setup.
//
import * as $mailapi from './clientapi/mailapi';
import * as $router from './worker-support/main-router';
import $configparser from './worker-support/configparser-main';
import $cronsync from './worker-support/cronsync-main';
import $devicestorage from './worker-support/devicestorage-main';
import $net from './worker-support/net-main';
import $wakelocks from './worker-support/wakelocks-main';


/**
 * Builder/loader/runtime specific mechanism for worker instantiation.
 */
import makeWorker from 'app_logic/worker_maker';

const control = {
  name: 'control',
  sendMessage: null,
  process: function(uid/*, cmd, args*/) {
    var online = navigator.onLine;
    control.sendMessage(uid, 'hello', [online]);

    window.addEventListener('online', function(evt) {
      control.sendMessage(uid, evt.type, [true]);
    });
    window.addEventListener('offline', function(evt) {
      control.sendMessage(uid, evt.type, [false]);
    });

    $router.unregister(control);
  },
};

const MailAPI = new $mailapi.MailAPI();
var worker;

const bridge = {
  name: 'bridge',
  sendMessage: null,
  process: function(uid, cmd, args) {
    var msg = args;

    if (msg.type === 'hello') {
      delete MailAPI._fake;
      MailAPI.__bridgeSend = function(sendMsg) {
        try {
          worker.postMessage({
            uid: uid,
            type: 'bridge',
            msg: sendMsg
          });
        } catch (ex) {
          console.error('Presumed DataCloneError on:', sendMsg);
        }
      };

      MailAPI.config = msg.config;

      // Send up all the queued messages to real backend now.
      MailAPI._storedSends.forEach(function (storedMsg) {
        MailAPI.__bridgeSend(storedMsg);
      });
      MailAPI._storedSends = [];

      MailAPI.__universeAvailable();
    } else {
      MailAPI.__bridgeReceive(msg);
    }
  },
};

// Wire up the worker to the router
/* If using require.js this module should look something like:

 */
worker = makeWorker();
logic.defineScope(worker, 'Worker');
worker.onerror = (event) => {
  logic(
    worker, 'workerError',
    {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno
    });
  // we do not preventDefault the event, we want as many other helpful error
  // reporting mechanisms to fire, etc.
};
$router.useWorker(worker);
$router.register(control);
$router.register(bridge);
$router.register($configparser);
$router.register($cronsync);
$router.register($devicestorage);
$router.register($net);
$router.register($wakelocks);

export default MailAPI;


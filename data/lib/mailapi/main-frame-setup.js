/**
 *
 **/

define(
  [
    // Pretty much everything could be dynamically loaded after we kickoff the
    // worker thread.  We just would need to be sure to latch any received
    // messages that we receive before we finish setup.
    './mailapi',
    './worker-support/configparser-main',
    './worker-support/cronsync-main',
    './worker-support/devicestorage-main',
    './worker-support/maildb-main',
    './worker-support/net-main',
    'require',
    'exports'
  ],
  function(
    $mailapi,
    $configparser,
    $cronsync,
    $devicestorage,
    $maildb,
    $net,
    require,
    exports
  ) {

  function debug(str) {
    //dump('WorkerListener: ' + str + '\n');
  }

  var listeners = {};
  var worker = null;

  function init() {
    worker = new Worker('js/ext/worker-bootstrap.js');

    worker.onmessage = function dispatchToListener(evt) {
      var data = evt.data;
      var listener = listeners['on' + data.type];
      if (listener)
        listener(data);
    };

    register(hello);
    register($configparser);
    register($cronsync);
    register($devicestorage);
    register($maildb);
    register($net);
  }

  function register(module) {
    var name = module.name;

    listeners['on' + name] = function(msg) {
      //debug('on' + name + ': ' + msg.uid + ' - ' + msg.cmd);
      module.process(msg.uid, msg.cmd, msg.args);
    };

    module.onmessage = function(uid, cmd, args) {
      //debug('onmessage: ' + name + ": " + uid + " - " + cmd);
      worker.postMessage({
        type: name,
        uid: uid,
        cmd: cmd,
        args: Array.isArray(args) ? args : [args]
      });
    }
  }

  function unregister(module) {
    delete listeners['on' + module.name];
  }

  var hello = {
    name: 'hello',
    onmessage: null,
    process: function(uid, cmd, args) {
      var online = navigator.onLine;
      var hasPendingAlarm = navigator.mozHasPendingMessage('alarm');
      hello.onmessage(uid, 'hello', [online, hasPendingAlarm]);

      window.addEventListener('online', function(evt) {
        hello.onmessage.postMessage(uid, evt.type, true);
      });
      window.addEventListener('offline', function(evt) {
        hello.onmessage.postMessage(uid, evt.type, false);
      });
      navigator.mozSetMessageHandler('alarm', function(msg) {
        hello.onmessage(uid, 'alarm', [msg]);
      });

      unregister(hello);
    }
  }

  listeners['onbridge'] = function(data) {
    var msg = data.msg;
    if (msg.type != 'hello')
      return;

    var uid = data.uid;

    var mailAPI = new $mailapi.MailAPI();
    mailAPI.__bridgeSend = function(msg) {
      worker.postMessage({
        uid: uid,
        type: 'bridge',
        msg: msg
      });
    };

    worker.addEventListener('message', function(evt) {
      if (evt.data.type != 'bridge' || evt.data.uid != uid)
        return;

      //dump("MailAPI receiveMessage: " + JSON.stringify(evt.data) + "\n");
      mailAPI.__bridgeReceive(evt.data.msg);
    });

    mailAPI.config = data.msg.config;

    var evt = document.createEvent('CustomEvent');
    evt.initCustomEvent('mailapi', false, false, { mailAPI: mailAPI });
    window.dispatchEvent(evt);
  }

  init();
}); // end define

/**
 * Assist mailapi/testhelper by spinning up the main thread support modules and
 * establishing a bouncer to redirect all mailapi traffic back to a MailAPI
 * instance instantiated in the worker.
 **/

define(
  [
    './main-router',
    './configparser-main',
    './cronsync-main',
    './devicestorage-main',
    './maildb-main',
    './net-main',
    'exports'
  ],
  function(
    $router,
    $configparser,
    $cronsync,
    $devicestorage,
    $maildb,
    $net,
    exports
  ) {

var realisticBridge = {
  name: 'bridge',
  sendMessage: null,
  process: function(uid, cmd, args) {
    bouncedBridge.sendMessage(uid, cmd, args);
  }
};
var bouncedBridge = {
  name: 'bounced-bridge',
  sendMessage: null,
  process: function(uid, cmd, args) {
    realisticBridge.sendMessage(uid, cmd, args);
  }
};
$router.register(realisticBridge);
$router.register(bouncedBridge);

var testHelper = {
  name: 'testhelper',
  sendMessage: null,
  process: function(uid, cmd, args) {
    if (cmd === 'checkDatabaseDoesNotContain') {
      var tablesAndKeyPrefixes = args;
      var idb = $maildb._debugDB._db,
          desiredStores = [], i, checkArgs;

      for (i = 0; i < tablesAndKeyPrefixes.length; i++) {
        checkArgs = tablesAndKeyPrefixes[i];
        desiredStores.push(checkArgs.table);
      }
      var trans = idb.transaction(desiredStores, 'readonly');

      var results = [];
      var sendResults = function() {
        testHelper.sendMessage(uid, 'checkDatabaseDoesNotContain', [results]);
      };

      var waitCount = tablesAndKeyPrefixes.length;
      tablesAndKeyPrefixes.forEach(function(checkArgs) {
        var store = trans.objectStore(checkArgs.table),
            range = IDBKeyRange.bound(checkArgs.prefix,
                                      checkArgs.prefix + '\ufff0',
                                      false, false),
            req = store.get(range);
        req.onerror = function(event) {
          results.push({ errCode: event.target.errorCode });
          if (--waitCount === 0)
            sendResults();
        };
        req.onsuccess = function() {
          results.push({ errCode: null,
                         table: checkArgs.table,
                         prefix: checkArgs.prefix,
                         hasResult: req.result !== undefined });
          if (--waitCount === 0)
            sendResults();
        };
      });
    }
  }
};
$router.register(testHelper);

var deviceStorageTestHelper = {
  name: 'th_devicestorage',
  sendMessage: null,
  process: function(uid, cmd, args) {
    if (cmd === 'attach') {
      this._storage = navigator.getDeviceStorage(args);
      this._storage.addEventListener('change', this._bound_onChange);
      this.sendMessage(null, 'attached', null);
    }
    else if (cmd === 'detach') {
      this._storage.removeEventListener('change', this._bound_onChange);
      this._storage = null;
      this.sendMessage(null, 'detached', null);
    }
    else if (cmd === 'get') {
      var req = this._storage.get(args.path);
      req.onsuccess = function() {
        this.sendMessage(null, 'got',
                         { id: args.id, error: null, blob: req.result });
      }.bind(this);
      req.onerror = function() {
        this.sendMessage(null, 'got',
                         { id: args.id, error: '' + req.error, blob: null });
      }.bind(this);
    }
  },
  _storage: null,
  _bound_onChange: null,
  _onChange: function(event) {
    this.sendMessage(null, 'change', { reason: event.reason, path: event.path });
  }
};
deviceStorageTestHelper._bound_onChange =
  deviceStorageTestHelper._onChange.bind(deviceStorageTestHelper);
$router.register(deviceStorageTestHelper);

$router.register($configparser);
$router.register($cronsync);
$router.register($devicestorage);
$router.register($maildb);
$router.register($net);

}); // end define

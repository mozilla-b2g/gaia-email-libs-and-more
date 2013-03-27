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

$router.register($configparser);
$router.register($cronsync);
$router.register($devicestorage);
$router.register($maildb);
$router.register($net);

}); // end define

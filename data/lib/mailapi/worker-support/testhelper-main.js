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

$router.register($configparser);
$router.register($cronsync);
$router.register($devicestorage);
$router.register($maildb);
$router.register($net);

}); // end define

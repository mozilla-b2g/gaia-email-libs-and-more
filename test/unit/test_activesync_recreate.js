/**
 * Test that we can re-create an ActiveSync account under online and offline
 * conditions.  This test should actually work for IMAP too...
 *
 * We also abuse this test to check the following transparent upgrade steps:
 * - If the accountDef.connInfo.deviceId does not exist, we allocate one.
 * - The accountDef.connInfo.deviceId does not change as a result of an upgrade.
 **/

define(function(require, exports) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var $wbxml = require('wbxml');
var $ascp = require('activesync/codepages');

return new LegacyGelamTest('create, recreate offline', function(T) {
  const FilterType = $ascp.AirSync.Enums.FilterType;
  const DEFAULT_MESSAGE_COUNT = 10;

  T.group('create old db');
  // create a database that will get migrated at next universe
  var TU1 = T.actor('TestUniverse', 'U1', { dbDelta: -1 }),
      TA1 = T.actor('TestAccount', 'A1',
                    { universe: TU1 }),
      eCheck = T.lazyLogger('check');

  // add some messages to the inbox
  var inbox1 = TA1.do_useExistingFolderWithType('inbox', '1');
  TA1.do_addMessagesToFolder(
    inbox1,
    { count: DEFAULT_MESSAGE_COUNT,
      age: { hours: 1 }, age_incr: { minutes: 1 } });

  T.group('go offline, shutdown');
  TU1.do_pretendToBeOffline(true);
  T.action(eCheck, 'nuke device id, save account def', function() {
    eCheck.expect('account def saved');

    delete TA1.account.accountDef.connInfo.deviceId;
    TA1.universe.saveAccountDef(
      TA1.account.accountDef, null, function() {
        eCheck.log('account def saved');
      });
  });
  TU1.do_saveState();
  TU1.do_shutdown();

  T.group('migrate while offline');
  // this universe will trigger lazy upgrade migration
  var TU2 = T.actor('TestUniverse', 'U2', { old: TU1, upgrade: true }),
      TA2 = T.actor('TestAccount', 'A2',
                    { universe: TU2, restored: 'upgrade' });
  // check that the inbox exists
  var inbox2 = TA2.do_useExistingFolderWithType('inbox', '2', inbox1);

  T.check(eCheck, 'account has device id', function() {
    eCheck.expect('has device id',  true);
    var deviceId = TA2.account.accountDef.connInfo.deviceId;
    eCheck.log('has device id', !!deviceId, deviceId);
  });

  T.group('kill folder sync, go online, try and sync');
  // Killing the folder sync means that when we go online, we don't try and sync
  // folders and that we should expect our Inbox sync to end up claiming there
  // are zero messages at the current time, and without error.  This is
  // because even though we are online, we don't know the serverId for the
  // folder and so we must do the offline sync case.
  var savedFolderSyncOpList = T.thing('opList', 'syncFolderList');
  TU2.do_killQueuedOperations(TA2, 'server', 1, savedFolderSyncOpList);
  TU2.do_pretendToBeOffline(false);
  var view2 = TA2.do_openFolderView(
    'sync', inbox2, null,
    { top: true, bottom: true, grow: true },
    { nosave: true, syncblocked: 'bail' });

  T.group('sync folder list triggers sync');
  TU2.do_restoreQueuedOperationsAndWait(TA2, savedFolderSyncOpList, function() {
    TA2.expect('messagesReported', { count: DEFAULT_MESSAGE_COUNT });
    TA2.expect_headerChanges(
      view2,
      { additions: inbox2.serverMessages, changes: [], deletions: [] });
  });
  TA2.do_closeFolderView(view2);


  T.group('shutdown');
  TU2.do_saveState();
  TU2.do_shutdown();

  T.group('create old db via nuke');
  // create a universe that nukes everything.
  var TU3 = T.actor('TestUniverse', 'U3',
                    { old: TU2, dbDelta: 1, nukeDb: true }),
      TA3 = T.actor('TestAccount', 'A3',
                    { universe: TU3 });
  var savedDeviceId;
  T.check('save off device id', function () {
    savedDeviceId = TA3.account.accountDef.connInfo.deviceId;
  });
  TU3.do_saveState();
  TU3.do_shutdown();

  T.group('migrate while online');
  // TODO: re-enable in whatever manner is appropriate, if at all
  // https://bugzil.la/1049264 filed with discussion
  /*
  var TU4 = T.actor('TestUniverse', 'U4',
                    { old: TU3, dbDelta: 2, upgrade: 'nowait' }),
      TA4 = T.actor('TestAccount', 'A4',
                    { universe: TU4, restored: 'upgrade' });
  var inbox4 = TA4.do_useExistingFolderWithType('inbox', '4', inbox1);

  T.check(eCheck, 'device id stayed the same', function() {
    eCheck.expect('device id',  savedDeviceId);
    eCheck.log('device id', TA4.account.accountDef.connInfo.deviceId);
  });

  TA4.do_viewFolder(
    'sync', inbox4,
    { count: DEFAULT_MESSAGE_COUNT, full: DEFAULT_MESSAGE_COUNT,
      flags: 0, changed: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false },
    { nosave: true, syncblocked: 'resolve', accountActive: true });
  */

  T.group('cleanup');
});

}); // end define

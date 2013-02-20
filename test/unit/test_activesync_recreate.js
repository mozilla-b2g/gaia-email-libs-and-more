/**
 * Test that we can re-create an ActiveSync account under online and offline
 * conditions.  This test should actually work for IMAP too...
 **/

load('resources/loggest_test_framework.js');
const $wbxml = require('wbxml');
const $ascp = require('activesync/codepages');

var TD = $tc.defineTestsFor(
  { id: 'test_activesync_recreate' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('create, recreate offline', function(T) {
  const FilterType = $ascp.AirSync.Enums.FilterType;

  T.group('create old db');
  // create a database that will get migrated at next universe
  var TU1 = T.actor('testUniverse', 'U1', { dbDelta: -1 }),
      TA1 = T.actor('testAccount', 'A1',
                    { universe: TU1 }),
      eCheck = T.lazyLogger('check');

  T.group('go offline, shutdown');
  TU1.do_pretendToBeOffline(true);
  TU1.do_saveState();
  TU1.do_shutdown();

  T.group('migrate while offline');
  // this universe will trigger lazy upgrade migration
  var TU2 = T.actor('testUniverse', 'U2'),
      TA2 = T.actor('testAccount', 'A2',
                    { universe: TU2, restored: true });
  // check that the inbox exists
  var inbox2 = TA2.do_useExistingFolderWithType('inbox', '2');

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
    { nosave: true });

  T.group('sync folder list triggers sync');
  TU2.do_restoreQueuedOperationsAndWait(TA2, savedFolderSyncOpList, function() {
    TA2.expect_messagesReported(inbox2.knownMessages.length);
    TA2.expect_headerChanges(
      view2,
      { additions: inbox2.knownMessages, changes: [], deletions: [] });
  });
  TA2.do_closeFolderView(view2);


  T.group('shutdown');
  TU2.do_saveState();
  TU2.do_shutdown();

  T.group('create old db');
  // create a universe that nukes everything.
  var TU3 = T.actor('testUniverse', 'U3', { dbDelta: 1, nukeDb: true }),
      TA3 = T.actor('testAccount', 'A3',
                    { universe: TU3 });
  TU3.do_saveState();
  TU3.do_shutdown();

  T.group('migrate while online');
  // this will trigger lazy upgrade migration
  var TU4 = T.actor('testUniverse', 'U4', { dbDelta: 2 }),
      TA4 = T.actor('testAccount', 'A4',
                    { universe: TU4, restored: true });
  const DEFAULT_MESSAGE_COUNT = 10;
  var inbox4 = TA4.do_useExistingFolderWithType('inbox', '4');
  TA4.do_viewFolder('sync', inbox4,
                    { count: DEFAULT_MESSAGE_COUNT,
                      full: DEFAULT_MESSAGE_COUNT, flags: 0, deleted: 0,
                      filterType: FilterType.NoFilter },
                    { top: true, bottom: true, grow: false });

  T.group('cleanup');
});

function run_test() {
  runMyTests(5);
}

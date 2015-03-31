/**
 * Test our ActiveSync sync logic under non-pathological conditions.  Currently,
 * this just tests that we can create an account successfully.  More tests
 * coming soon!
 **/

define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var $wbxml = require('wbxml');
var $ascp = require('activesync/codepages');

// This is the number of messages after which the sync logic will
// declare victory and stop filling.
const INITIAL_FILL_SIZE = 15;

return new LegacyGelamTest('folder sync', function(T, RT) {
  var TEST_PARAMS = RT.envOptions;
  const FilterType = $ascp.AirSync.Enums.FilterType;
  var type = RT.envOptions.type;

  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A',
                            { universe: testUniverse }),
      eSync = T.lazyLogger('sync');

  T.action(eSync, 'check initial folder list', testAccount, function() {
    eSync.expect('inbox', {
      syncKey: (type === 'activesync' ? '0' : null),
      hasServerId:  (type === 'activesync' ? true : false),
    });
    var folder = testAccount.account.getFirstFolderWithType('inbox');
    eSync.log('inbox', {
      syncKey: (type === 'activesync' ? folder.syncKey : null),
      hasServerId: folder.serverId !== null
    });
  });

  /**
   * Try and synchronize an empty folder.  Verify that our slice completes with
   * minimal legwork.
   */
  T.group('sync empty folder');
  var emptyFolder = testAccount.do_createTestFolder(
    'test_empty_sync', { count: 0 });
  testAccount.do_viewFolder(
    'syncs', emptyFolder,
    { count: 0, full: 0, flags: 0, changed: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false });
  testUniverse.do_pretendToBeOffline(true);
  testAccount.do_viewFolder(
    'checks persisted data of', emptyFolder,
    { count: 0, full: 0, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false });
  testUniverse.do_pretendToBeOffline(false);
  testAccount.do_viewFolder(
    'resyncs', emptyFolder,
    { count: 0, full: 0, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false });

  /**
   * Perform a folder sync where our initial time fetch window contains all of
   * the messages in the folder.
   */
  T.group('initial interval is full sync');
  var fullSyncFolder = testAccount.do_createTestFolder(
    'test_initial_full_sync',
    { count: 4, age: { days: 0, hours: 2 }, age_incr: { days: 1 } });
  testAccount.do_viewFolder(
    'syncs', fullSyncFolder,
    { count: 4, full: 4, flags: 0, changed: 0, deleted: 0,
    filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false, newCount: null });
  testUniverse.do_pretendToBeOffline(true);
  testAccount.do_viewFolder(
    'checks persisted data of', fullSyncFolder,
    { count: 4, full: 0, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: null });
  testUniverse.do_pretendToBeOffline(false);
  testAccount.do_viewFolder(
    'resyncs', fullSyncFolder,
    { count: 4, full: 0, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: 0 });


  T.group('sync detects additions');
  testAccount.do_addMessagesToFolder(
    fullSyncFolder,
    { count: 2, age: { hours: 1 }, age_incr: { days: 1 } });
  var folderView = testAccount.do_openFolderView(
    'fullSyncFolder', fullSyncFolder,
    { count: 6, full: 2, flags: 0, changed: 0, deleted: 0 },
    // only one of the messages is newer than the most recent message!
    { top: true, bottom: true, grow: false, newCount: 1 });

  T.group('sync detects deletions');
  testAccount.do_deleteMessagesOnServerThenRefresh(folderView, [0]);
  testAccount.do_closeFolderView(folderView);

  /**
   * Perform a folder sync where our initial time fetch window contains more
   * messages than we want and there are even more messages beyond.
   */
  T.group('saturated initial interval');
  var saturatedFolder = testAccount.do_createTestFolder(
    'test_saturated_sync',
    { count: 30, age: { days: 0 }, age_incr: { days: 1 } });
  testAccount.do_viewFolder(
    'syncs', saturatedFolder,
    { count: INITIAL_FILL_SIZE, full: 30, flags: 0, changed: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: false, grow: false });
  testUniverse.do_pretendToBeOffline(true);
  // We get all the headers in one go because we are offline, and they get
  // thresholded to the initial fill size.
  testAccount.do_viewFolder('checks persisted data of', saturatedFolder,
    { count: INITIAL_FILL_SIZE, full: 0, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });
  testUniverse.do_pretendToBeOffline(false);
  testAccount.do_viewFolder(
    'resyncs', saturatedFolder,
    { count: INITIAL_FILL_SIZE, full: 0, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });

  /* ACTIVESYNC ONLY FROM HERE ON DOWN! */
  if (TEST_PARAMS.type === 'pop3') {
    T.group('cleanup');
    return;
  }

  /**
   * Perform a folder sync where our initial time fetch window contains a subset
   * of the messages in the folder.
   */
  T.group('initial interval is partial sync');
  var partialSyncFolder = testAccount.do_createTestFolder(
    'test_initial_partial_sync',
    { count: 60, age: { days: 0 }, age_incr: { days: 1 } });
  testAccount.do_viewFolder(
    'syncs', partialSyncFolder,
    { count: INITIAL_FILL_SIZE, full: 31, flags: 0, changed: 0, deleted: 0,
      filterType: FilterType.OneMonthBack },
    { top: true, bottom: false, grow: false });
  testUniverse.do_pretendToBeOffline(true);
  testAccount.do_viewFolder(
    'checks persisted data of', partialSyncFolder,
    { count: INITIAL_FILL_SIZE, full: 0, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });
  testUniverse.do_pretendToBeOffline(false);
  testAccount.do_viewFolder(
    'resyncs', partialSyncFolder,
    { count: INITIAL_FILL_SIZE, full: 0, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });

  T.group('change sync range to all messages');
  testAccount.do_modifyAccount({ syncRange: 'all' });
  testAccount.do_viewFolder(
    'syncs', partialSyncFolder,
    { count: INITIAL_FILL_SIZE, full: 60, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: false, grow: false },
    { recreateFolder: true });

  T.group('manual sync range');
  var manualRangeFolder = testAccount.do_createTestFolder(
    'test_manual_range_sync',
    { count: 60, age: { days: 0 }, age_incr: { hours: 2 } });
  testAccount.do_viewFolder(
    'syncs', manualRangeFolder,
    { count: INITIAL_FILL_SIZE, full: 60, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });
  testUniverse.do_pretendToBeOffline(true);
  testAccount.do_viewFolder(
    'checks persisted data of', manualRangeFolder,
    { count: INITIAL_FILL_SIZE, full: 0, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });
  testUniverse.do_pretendToBeOffline(false);
  testAccount.do_viewFolder(
    'resyncs', manualRangeFolder,
    { count: INITIAL_FILL_SIZE, full: 0, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });

  T.group('cleanup');
});

}); // end define

/**
 * Test our ActiveSync sync logic under non-pathological conditions.  Currently,
 * this just tests that we can create an account successfully.  More tests
 * coming soon!
 **/

load('resources/loggest_test_framework.js');
const $wbxml = require('wbxml');
const $ascp = require('activesync/codepages');

// This is the number of messages after which the sync logic will
// declare victory and stop filling.
const INITIAL_FILL_SIZE = 15;

var TD = $tc.defineTestsFor(
  { id: 'test_activesync_general' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('folder sync', function(T) {
  const FilterType = $ascp.AirSync.Enums.FilterType;

  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse }),
      eSync = T.lazyLogger('sync');

  T.action(eSync, 'check initial folder list', testAccount, function() {
    eSync.expect_namedValue('inbox', {
      syncKey: '0',
      hasServerId: true
    });

    var folder = testAccount.account.getFirstFolderWithType('inbox');
    eSync.namedValue('inbox', {
      syncKey: folder.syncKey,
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
  testAccount.do_viewFolder('syncs', emptyFolder,
                            { count: 0, full: 0, flags: 0, deleted: 0,
                              filterType: FilterType.NoFilter },
                            { top: true, bottom: true, grow: false });
  testUniverse.do_pretendToBeOffline(true);
  testAccount.do_viewFolder('checks persisted data of', emptyFolder,
                            { count: 0, full: 0, flags: 0, deleted: 0 },
                            { top: true, bottom: true, grow: false });
  testUniverse.do_pretendToBeOffline(false);
  testAccount.do_viewFolder('resyncs', emptyFolder,
                            { count: 0, full: 0, flags: 0, deleted: 0 },
                            { top: true, bottom: true, grow: false });

  /**
   * Perform a folder sync where our initial time fetch window contains all of
   * the messages in the folder.
   */
  T.group('initial interval is full sync');
  var fullSyncFolder = testAccount.do_createTestFolder(
    'test_initial_full_sync',
    { count: 4, age: { days: 0 }, age_incr: { days: 1 } });
  testAccount.do_viewFolder('syncs', fullSyncFolder,
                            { count: 4, full: 4, flags: 0, deleted: 0,
                              filterType: FilterType.NoFilter },
                            { top: true, bottom: true, grow: false });
  testUniverse.do_pretendToBeOffline(true);
  testAccount.do_viewFolder('checks persisted data of', fullSyncFolder,
                            { count: 4, full: 0, flags: 0, deleted: 0 },
                            { top: true, bottom: true, grow: false });
  testUniverse.do_pretendToBeOffline(false);
  testAccount.do_viewFolder('resyncs', fullSyncFolder,
                            { count: 4, full: 0, flags: 0, deleted: 0 },
                            { top: true, bottom: true, grow: false });


  T.group('sync detects additions');
  testAccount.do_addMessagesToFolder(fullSyncFolder, { count: 1,
                                                       age: { hours: 1 } });
  var folderView = testAccount.do_openFolderView(
    'fullSyncFolder', fullSyncFolder,
    { count:  5, full: 1, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false });

  T.group('sync detects deletions');
  T.action('blah', testAccount, eSync, function() {
    var headers = folderView.slice.items,
        toDelete = headers[0],
        toDeleteId = fullSyncFolder.knownMessages[0].messageId,
        expectedValues = { count: 4, full: 0, flags: 0, deleted: 1 },
        checkExpected = { changes: [], deletions: [toDelete] },
        expectedFlags = { top: true, bottom: true, grow: false };

    fullSyncFolder.beAwareOfDeletion(0);
    fullSyncFolder.serverFolder.removeMessageById(toDeleteId);
    var totalExpected = testAccount._expect_dateSyncs(folderView, expectedValues);
    testAccount.expect_messagesReported(totalExpected);
    testAccount.expect_headerChanges(folderView, checkExpected, expectedFlags);

    testAccount._expect_storage_mutexed(folderView.testFolder, 'refresh');

    folderView.slice.refresh();
  });

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
    { count: INITIAL_FILL_SIZE, full: 30, flags: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: false, grow: false });
  testUniverse.do_pretendToBeOffline(true);
  // We get all the headers in one go because we are offline, and they get
  // thresholded to the initial fill size.
  testAccount.do_viewFolder('checks persisted data of', saturatedFolder,
    { count: INITIAL_FILL_SIZE, full: 0, flags: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });
  testUniverse.do_pretendToBeOffline(false);
  testAccount.do_viewFolder(
    'resyncs', saturatedFolder,
    { count: INITIAL_FILL_SIZE, full: 0, flags: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });

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
    { count: INITIAL_FILL_SIZE, full: 31, flags: 0, deleted: 0,
      filterType: FilterType.TwoWeeksBack },
    { top: true, bottom: false, grow: false });
  testUniverse.do_pretendToBeOffline(true);
  testAccount.do_viewFolder(
    'checks persisted data of', partialSyncFolder,
    { count: INITIAL_FILL_SIZE, full: 0, flags: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });
  testUniverse.do_pretendToBeOffline(false);
  testAccount.do_viewFolder(
    'resyncs', partialSyncFolder,
    { count: INITIAL_FILL_SIZE, full: 0, flags: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });

  T.group('change sync range to all messages');
  T.action(eSync, 'change sync range', function() {
    eSync.expect_event('roundtrip');
    var acct = testUniverse.allAccountsSlice.items[0];
    acct.modifyAccount({ syncRange: 'all' });
    // we don't need to wait for correctness; just to keep any errors in the
    // right test step rather than letting them smear into the next one.
    testUniverse.MailAPI.ping(function() {
      eSync.event('roundtrip');
    });
  });
  testAccount.do_viewFolder(
    'syncs', partialSyncFolder,
    { count: INITIAL_FILL_SIZE, full: 60, flags: 0, deleted: 0,
      recreateFolder: true },
    { top: true, bottom: false, grow: false });

  T.group('manual sync range');
  var manualRangeFolder = testAccount.do_createTestFolder(
    'test_manual_range_sync',
    { count: 60, age: { days: 0 }, age_incr: { hours: 2 } });
  testAccount.do_viewFolder(
    'syncs', manualRangeFolder,
    { count: INITIAL_FILL_SIZE, full: 60, flags: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });
  testUniverse.do_pretendToBeOffline(true);
  testAccount.do_viewFolder(
    'checks persisted data of', manualRangeFolder,
    { count: INITIAL_FILL_SIZE, full: 0, flags: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });
  testUniverse.do_pretendToBeOffline(false);
  testAccount.do_viewFolder(
    'resyncs', manualRangeFolder,
    { count: INITIAL_FILL_SIZE, full: 0, flags: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });

  T.group('cleanup');
  testAccount.do_closeFolderView(folderView);
});

function run_test() {
  runMyTests(10);
}

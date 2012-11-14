/**
 * Test our ActiveSync sync logic under non-pathological conditions.  Currently,
 * this just tests that we can create an account successfully.  More tests
 * coming soon!
 **/

load('resources/loggest_test_framework.js');
const $wbxml = require('wbxml');
const $ascp = require('activesync/codepages');

var TD = $tc.defineTestsFor(
  { id: 'test_activesync_general' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('folder sync', function(T) {
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
                            { count: 0, full: 0, flags: 0, deleted: 0 },
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
                            { count: 4, full: 4, flags: 0, deleted: 0 },
                            { top: true, bottom: true, grow: false });
  testUniverse.do_pretendToBeOffline(true);
  testAccount.do_viewFolder('checks persisted data of', fullSyncFolder,
                            { count: 4, full: 0, flags: 0, deleted: 0 },
                            { top: true, bottom: true, grow: false });
  testUniverse.do_pretendToBeOffline(false);
  testAccount.do_viewFolder('resyncs', fullSyncFolder,
                            { count: 4, full: 0, flags: 4, deleted: 0 },
                            { top: true, bottom: true, grow: false });


  T.group('sync detects additions');
  testAccount.do_addMessagesToFolder(fullSyncFolder, { count: 1,
                                                       age: { hours: 1 } });
  var folderView = testAccount.do_openFolderView(
    'fullSyncFolder', fullSyncFolder,
    { count:  5, full: 1, flags: 4, deleted: 0 },
    { top: true, bottom: true, grow: false });

  /**
   * Perform a folder sync where our initial time fetch window contains a subset
   * of the messages in the folder.
   */
  T.group('initial interval is partial sync');
  var partialSyncFolder = testAccount.do_createTestFolder(
    'test_initial_partial_sync',
    { count: 60, age: { days: 0 }, age_incr: { days: 1 } });
  testAccount.do_viewFolder('syncs', partialSyncFolder,
                            { count: 15, full: 15, flags: 0, deleted: 0 },
                            { top: true, bottom: false, grow: false });
  testUniverse.do_pretendToBeOffline(true);
  testAccount.do_viewFolder('checks persisted data of', partialSyncFolder,
                            { count: 15, full: 0, flags: 0, deleted: 0 },
                            { top: true, bottom: false, grow: false });
  testUniverse.do_pretendToBeOffline(false);
  testAccount.do_viewFolder('resyncs', partialSyncFolder,
                            { count: 15, full: 0, flags: 15, deleted: 0 },
                            { top: true, bottom: false, grow: false });

  T.group('cleanup');
  testAccount.do_closeFolderView(folderView);
});

function run_test() {
  runMyTests(10);
}

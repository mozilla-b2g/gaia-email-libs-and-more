/**
 * Test IMAP (and general MailUniverse) functionality that should not vary
 * based on the server.  This covers:
 *
 * - Persistence of account data through setup and teardown.
 * - That teardown kills IMAP connections. (untested right now?)
 * - Sync further back into time on demand.
 **/

load('resources/loggest_test_framework.js');

var TD = $tc.defineTestsFor(
  { id: 'test_imap_internals' }, null, [$th_imap.TESTHELPER], ['app']);

TD.DISABLED_commonCase('account persistence', function(T) {
  T.group('create universe, account');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A', { universe: testUniverse });

  T.group('cram messages in, sync them');
  var testFolder = testAccount.do_createTestFolder(
    'test_internals',
    { count: 4, age: { days: 0 }, age_incr: { days: 1 } });
  testAccount.do_viewFolder('syncs', testFolder,
                            { count: 4, full: 4, flags: 0, deleted: 0 });

  T.group('cleanly shutdown account, universe');
  testUniverse.do_saveState();
  testUniverse.do_shutdown();

  T.group('reload account, universe');
  // rebind to new universe / (loaded) account
  testUniverse = T.actor('testUniverse', 'U2'),
  testAccount = T.actor('testImapAccount', 'A2',
                        { universe: testUniverse, restored: true });

  T.group('verify sync is not starting from scratch');
  testFolder = testAccount.do_useExistingFolder('test_internals', '#2',
                                                testFolder);
  testAccount.do_viewFolder('re-syncs', testFolder,
                            { count: 4, full: 0, flags: 4, deleted: 0 });

  T.group('add more messages, verify sync');
  testAccount.do_addMessagesToFolder(
    testFolder,
    { count: 2, age: { days: 0, hours: 2 }, age_incr: { days: 1 } });
  testAccount.do_viewFolder('re-syncs', testFolder,
                            { count: 6, full: 2, flags: 4, deleted: 0 });

  T.group('save account state');
  testUniverse.do_saveState();

  T.group('uncleanly shutdown account, universe');
  // so, yeah, this is exactly like our clean shutdown, effectively...
  testUniverse.do_shutdown();

  T.group('reload account, universe; check syncs detect nothing new');
  testUniverse = T.actor('testUniverse', 'U3');
  testAccount = T.actor('testImapAccount', 'A3',
                        { universe: testUniverse, restored: true });
  testFolder = testAccount.do_useExistingFolder('test_internals', '#3',
                                                testFolder);
  testAccount.do_viewFolder('re-syncs', testFolder,
                            { count: 6, full: 0, flags: 6, deleted: 0 });

  T.group('cleanup');
});


TD.commonCase('sync further back in time on demand', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A', { universe: testUniverse }),
      eSync = T.lazyLogger('sync');

  T.group('initial sync');
  // Create 3 time regions that sync's heuristics will view as sufficient for
  // initial sync and each growth.  The intervals work out to 7.5 days,
  // 7 days, and 7 days.  So we pick 11.9 hours to get 16, 15, 15.
  var syncFolder = testAccount.do_createTestFolder(
    'test_sync_grow',
    { count: 46, age: { days: 0 }, age_incr: { hours: 11.9 } });
  var syncView = testAccount.do_openFolderView(
    'grower', syncFolder,
    { count: 16, full: 16, flags: 0, deleted: 0 });

  T.group('grow');
  testAccount.do_growFolderView(
    syncView, 1, true,
    { count: 15, full: 15, flags: 0, deleted: 0 });
  testAccount.do_growFolderView(
    syncView, 1, true,
    { count: 15, full: 15, flags: 0, deleted: 0 });

  T.group('cleanup');
});

function run_test() {
  runMyTests(20);
}

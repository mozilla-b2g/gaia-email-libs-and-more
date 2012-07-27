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

TD.commonCase('account persistence', function(T) {
  T.group('create universe, account');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A', { universe: testUniverse });

  T.group('cram messages in, sync them');
  var testFolder = testAccount.do_createTestFolder(
    'test_internals',
    { count: 4, age: { days: 0 }, age_incr: { days: 1 } });
  testAccount.do_viewFolder(
    'syncs', testFolder,
    { count: 4, full: 4, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false });

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
  testAccount.do_viewFolder(
    're-syncs', testFolder,
    { count: 4, full: 0, flags: 4, deleted: 0 },
    { top: true, bottom: true, grow: false });

  T.group('add more messages, verify sync');
  testAccount.do_addMessagesToFolder(
    testFolder,
    { count: 2, age: { days: 0, hours: 2 }, age_incr: { days: 1 } });
  testAccount.do_viewFolder(
    're-syncs', testFolder,
    { count: 6, full: 2, flags: 4, deleted: 0 },
    { top: true, bottom: true, grow: false });

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
  testAccount.do_viewFolder(
    're-syncs', testFolder,
    { count: 6, full: 0, flags: 6, deleted: 0 },
    { top: true, bottom: true, grow: false });

  T.group('cleanup');
});


/**
 * This is our primary test of 'grow' logic.
 */
TD.commonCase('sync further back in time on demand', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('sync');

  T.group('initial sync');
  // Create 3 time regions that sync's heuristics will view as sufficient for
  // initial sync and each growth.  The intervals work out to 7.5 days,
  // 7 days, and 7 days.  So we pick 11.5 hours to get 16, 15, 15.
  var syncFolder = testAccount.do_createTestFolder(
    'test_sync_grow',
    { count: 45, age: { days: 0.5 }, age_incr: { hours: 11.4 } });
  var syncView = testAccount.do_openFolderView(
    'grower', syncFolder,
    { count: 15, full: 15, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: true });

  T.group('fail to grow older without request');
  testAccount.do_growFolderView(
    syncView, 1, false, 15,
    [],
    { top: true, bottom: true, grow: true }, 'nosave');

  T.group('fail to grow older when offline');
  testUniverse.do_pretendToBeOffline(true);
  testAccount.do_growFolderView(
    syncView, 1, true, 15,
    [],
    { top: true, bottom: true, grow: true }, 'nosave');
  testUniverse.do_pretendToBeOffline(false);

  T.group('grow older (sync more than requested)');
  // only ask for 11 messages, but sync 15.
  testAccount.do_growFolderView(
    syncView, 11, true, 15,
    { count: 11, full: 15, flags: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });
  T.group('grow older, get spare from last sync');
  // We're asking for 15 here, but we should just get a sync on the spare 4
  // from last time.  We had a bug previously where this date sync would still
  // have more desiredHeaders left-over and so would accidentally trigger a
  // further sync without explicit user action which is not cool.
  testAccount.do_growFolderView(
    syncView, 15, false, 26,
    { count: 4, full: 0, flags: 4, deleted: 0 },
    { top: true, bottom: true, grow: true });
  T.group('grow older (normal)');
  testAccount.do_growFolderView(
    syncView, 15, true, 30,
    { count: 15, full: 15, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false });

  T.group('shrink off new');
  testAccount.do_shrinkFolderView(
    syncView, 1, null, 44,
    { top: false, bottom: true, grow: false });
  testAccount.do_shrinkFolderView(
    syncView, 15, null, 29,
    { top: false, bottom: true, grow: false });

  T.group('grow younger again');
  testAccount.do_growFolderView(
    syncView, -8, false, 37,
    [],
    { top: false, bottom: true, grow: false }, 'nosave');
  testAccount.do_growFolderView(
    syncView, -8, false, 45,
    [],
    { top: true, bottom: true, grow: false }, 'nosave');


  T.group('shrink off old');
  testAccount.do_shrinkFolderView(
    syncView, 0, -2, 44, // -2 gets rid of 1, because it's inclusive
    { top: true, bottom: false, grow: false });
  testAccount.do_shrinkFolderView(
    syncView, 0, -21, 24, // -21 gets rid of 20, because it's inclusive
    { top: true, bottom: false, grow: false });

  T.group('grow old again');
  testAccount.do_growFolderView(
    syncView, 21, false, 45,
    [],
    { top: true, bottom: true, grow: false });

  T.group('cleanup');
  testAccount.do_closeFolderView(syncView);
});

/**
 * Grow a slice where the initial sync will fail to find any messages and so
 * it will need to issue additional requests to find those messages.
 */
TD.commonCase('grow with deepening required', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('sync');

  T.group('populate folder');
  var syncFolder = testAccount.do_createTestFolder(
    'test_sync_grow_deepen',
    { count: 15, age: { days: 0 }, age_incr: { hours: 12 } });
  testAccount.do_addMessagesToFolder(
    syncFolder,
    { count: 15, age: { days: 30}, age_incr: { hours: 24} });

  T.group('initial sync');
  var syncView = testAccount.do_openFolderView(
    'grower', syncFolder,
    { count: 15, full: 15, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: true });


  T.group('grow older with deepending');
  testAccount.do_growFolderView(
    syncView, 15, true, 15,
    [{ count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 11, full: 11, flags: 0, deleted: 0 },
     { count: 4, full: 4, flags: 0, deleted: 0 }],
    { top: true, bottom: true, grow: false });

  T.group('cleanup');
  testAccount.do_closeFolderView(syncView);
});

function run_test() {
  runMyTests(15);
}

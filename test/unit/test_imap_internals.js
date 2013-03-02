/**
 * Test IMAP (and general MailUniverse) functionality that should not vary
 * based on the server.  This covers:
 *
 * - Persistence of account data through setup and teardown.
 * - That teardown kills IMAP connections. (untested right now?)
 * - Sync further back into time on demand ('grow')
 **/

load('resources/loggest_test_framework.js');

var TD = $tc.defineTestsFor(
  { id: 'test_imap_internals' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('account persistence', function(T) {
  T.group('U1: create universe, account');
  //////////////////////////////////////////////////////////////////////////////
  // Universe 1 : initial
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A', { universe: testUniverse }),
      eSync = T.lazyLogger('sync');

  T.group('cram messages in, sync them');
  var testFolder = testAccount.do_createTestFolder(
    'test_internals',
    { count: 4, age: { days: 0 }, age_incr: { days: 1 } });
  testAccount.do_viewFolder(
    'syncs', testFolder,
    { count: 4, full: 4, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.group('(cleanly) shutdown account, universe');
  testUniverse.do_saveState();
  testUniverse.do_shutdown();

  //////////////////////////////////////////////////////////////////////////////
  // Universe 2 : add messages
  T.group('U2 [add]: reload account, universe');
  // rebind to new universe / (loaded) account
  testUniverse = T.actor('testUniverse', 'U2', { old: testUniverse });
  var TA2 = testAccount = T.actor('testAccount', 'A2',
                        { universe: testUniverse, restored: true });

  T.group('verify sync is not starting from scratch');
  var TF2 = testFolder = testAccount.do_useExistingFolder(
                           'test_internals', '#2', testFolder);
  testAccount.do_viewFolder(
    're-syncs', testFolder,
    { count: 4, full: 0, flags: 4, deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.group('add more messages, verify sync');
  testAccount.do_addMessagesToFolder(
    testFolder,
    { count: 2, age: { days: 0, hours: 2 }, age_incr: { days: 1 } });
  testAccount.do_viewFolder(
    're-syncs', testFolder,
    { count: 6, full: 2, flags: 4, deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  //////////////////////////////////////////////////////////////////////////////
  // Universe 3 : delete messages
  T.group('U3 [delete]: reload account, universe');
  // rebind to new universe / (loaded) account
  var TU3 = testUniverse = T.actor('testUniverse', 'U3', { old: testUniverse });
  var TA3 = testAccount = T.actor('testAccount', 'A3',
                            { universe: testUniverse, restored: true });

  T.group('verify sync is not starting from scratch');
  var TF3 = testFolder = testAccount.do_useExistingFolder(
                           'test_internals', '#3', testFolder);

  T.group('delete messages, sync');
  var deletedHeader;
  testAccount.do_manipulateFolder(testFolder, 'nolocal', function(slice) {
    deletedHeader = slice.items[0];
    MailAPI.modifyMessageTags([deletedHeader], ['\\Deleted'], null, 'delete');

    // (this is low-level IMAP Deletion and is just a flag change)
    for (var i = 0; i < 1; i++) {
      TA3.expect_runOp('modtags',
                       { local: false, server: true, save: false });
    }

    // update our test's idea of what messages exist where.
    TF3.beAwareOfDeletion(0);
  });
  testAccount.do_viewFolder(
    're-syncs', testFolder,
    { count: 5, full: 0, flags: 5, deleted: 1 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.group('save account state');
  testUniverse.do_saveState();

  T.group('(uncleanly) shutdown account, universe');
  // so, yeah, this is exactly like our clean shutdown, effectively...
  testUniverse.do_shutdown();

  //////////////////////////////////////////////////////////////////////////////
  // Universe 4 : change messages
  T.group('U4 [change]: reload account, universe');
  // rebind to new universe / (loaded) account
  var TU4 = testUniverse = T.actor('testUniverse', 'U4', { old: testUniverse });
  var TA4 = testAccount = T.actor('testAccount', 'A4',
                            { universe: testUniverse, restored: true });

  T.group('verify sync is not starting from scratch');
  var TF4 = testFolder = testAccount.do_useExistingFolder(
                           'test_internals', '#4', testFolder);

  var s0subject, s1subject;
  testAccount.do_manipulateFolder(testFolder, 'nolocal', function(slice) {
    s0subject = slice.items[0].subject;
    slice.items[0].setRead(true);
    s1subject = slice.items[1].subject;
    slice.items[1].setStarred(true);
    for (var i = 0; i < 2; i++) {
      TA4.expect_runOp('modtags',
                       { local: false, server: true, save: false });
    }
  });
  var TV4 = testAccount.do_openFolderView(
    're-syncs', testFolder,
    { count: 5, full: 0, flags: 5, deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  T.check('check modified message flags', eSync, function() {
    eSync.expect_namedValue('0:subject', s0subject);
    eSync.expect_namedValue('0:read', true);
    eSync.expect_namedValue('1:subject', s1subject);
    eSync.expect_namedValue('1:starred', true);

    eSync.namedValue('0:subject', TV4.slice.items[0].subject);
    eSync.namedValue('0:read', TV4.slice.items[0].isRead);
    eSync.namedValue('1:subject', TV4.slice.items[1].subject);
    eSync.namedValue('1:starred', TV4.slice.items[1].isStarred);
  });
  testAccount.do_closeFolderView(TV4);

  T.group('save account state');
  testUniverse.do_saveState();

  T.group('(uncleanly) shutdown account, universe');
  // so, yeah, this is exactly like our clean shutdown, effectively...
  testUniverse.do_shutdown();

  //////////////////////////////////////////////////////////////////////////////
  // Universe 5 : checks
  T.group('U5 [check]: reload account, universe');
  var TU5 = testUniverse = T.actor('testUniverse', 'U5', { old: testUniverse });
  testAccount = T.actor('testAccount', 'A5',
                        { universe: testUniverse, restored: true });
  var TF5 = testFolder = testAccount.do_useExistingFolder(
                           'test_internals', '#', testFolder);
  var TV5 = testAccount.do_openFolderView(
    're-syncs', testFolder,
    { count: 5, full: 0, flags: 5, deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.group('verify modified message flags');
  T.check('check modified message flags', eSync, function() {
    eSync.expect_namedValue('0:read', true);
    eSync.expect_namedValue('1:starred', true);

    eSync.namedValue('0:read', TV5.slice.items[0].isRead);
    eSync.namedValue('1:starred', TV5.slice.items[1].isStarred);
  });
  testAccount.do_closeFolderView(TV5);

  T.group('fail to get the message body for a deleted message');
  T.action(eSync, 'request deleted message body from',
           testFolder.storageActor, function() {
    eSync.expect_namedValue('bodyInfo', null);
    // TF5/TU6 are latched in case we add another step and the static/dynamic
    // values no longer line up.
    TF5.storageActor.expect_bodyNotFound();
    // Use the underlying method used by header.getBody since the dead header
    // is part of a dead object tree.
    TU5.MailAPI._getBodyForMessage(deletedHeader, function(bodyInfo) {
      eSync.namedValue('bodyInfo', bodyInfo);
    });
  });

  T.group('cleanup');
});


/**
 * This is our primary test of 'grow' logic.
 */
TD.commonCase('sync further back in time on demand', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('sync');
  // Use a fill size of 14 messages because it's easy to get 14 in 7 days with
  // 2 messages per day.
  const MINUTE_MILLIS = 60 * 1000, HOUR_MILLIS = 60 * MINUTE_MILLIS;
  testUniverse.do_adjustSyncValues({
    fillSize: 14,
    days: 7,
    growDays: 7,

    // set the refresh threshold at 30 minutes so advancing an hour will
    // cause a refresh to trigger.
    openRefreshThresh: 30 * MINUTE_MILLIS,
    growRefreshThresh: 30 * MINUTE_MILLIS,
  });

  var staticNow = new Date(2012, 0, 28, 12, 0, 0).valueOf();
  testUniverse.do_timewarpNow(staticNow, 'Jan 28th noon');

  T.group('initial sync');
  // Create 3 time regions that sync's heuristics will view as sufficient for
  // initial sync and each growth (14 per week).
  var syncFolder = testAccount.do_createTestFolder(
    'test_sync_grow',
    { count: 42,
      age: { days: 1, minutes: 1, seconds: 9 },
      age_incr: { days: 1 }, age_incr_every: 2 });
  var syncView = testAccount.do_openFolderView(
    'grower', syncFolder,
    { count: 14, full: 14, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: true });

  T.group('fail to grow older without request');
  testAccount.do_growFolderView(
    syncView, 1, false, 14,
    [],
    { top: true, bottom: true, grow: true },
    { nonet: true });

  T.group('fail to grow older when offline');
  testUniverse.do_pretendToBeOffline(true);
  testAccount.do_growFolderView(
    syncView, 1, true, 14,
    [],
    { top: true, bottom: true, grow: true },
    { nonet: true });
  testUniverse.do_pretendToBeOffline(false);

  T.group('grow older (grow: sync more than requested)');
  // only ask for 11 messages, but sync 14.
  testAccount.do_growFolderView(
    syncView, 11, true, 14,
    { count: 11, full: 14, flags: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });
  T.group('grow older, get spare from last sync');
  // We're asking for 14 here, but we should just get a batch of the spare 3
  // from last time.  We have timely data for all of the headers, so no refresh
  // is required and they will be directly filled.
  testAccount.do_growFolderView(
    syncView, 14, false, 25,
    { count: 3 },
    { top: true, bottom: true, grow: true },
    { nonet: true });
  T.group('grow older (grow: exactly what was requested)');
  testAccount.do_growFolderView(
    syncView, 14, true, 28,
    { count: 14, full: 14, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.group('shrink off new');
  testAccount.do_shrinkFolderView(
    syncView, 1, null, 41,
    { top: false, bottom: true, grow: false });
  testAccount.do_shrinkFolderView(
    syncView, 14, null, 27,
    { top: false, bottom: true, grow: false });

  T.group('shrink off old');
  testAccount.do_shrinkFolderView(
    syncView, 0, -8, 20, // -8 gets rid of 7, because it's inclusive
    { top: false, bottom: false, grow: false });

  T.group('grow younger again (cached, no refresh)');
  testAccount.do_growFolderView(
    syncView, -7, false, 20,
    { count: 7 },
    { top: false, bottom: false, grow: false },
    { nonet: true });

  T.group('grow younger again (refresh required)');
  staticNow += HOUR_MILLIS;
  testUniverse.do_timewarpNow(staticNow, '+1 hour');
  testAccount.do_growFolderView(
    syncView, -8, false, 27,
    // We get told about 10 flags here rather than just the 8 we are asking for
    // because that time warp means that the accuracy range covering our newest
    // message on Jan 23rd no longer holds and so we will refresh them too.
    // (We bother considering the same day because, as of this writing, we do
    // not support partial day sync, but we will soon.)
    { count: 8, full: 0, flags: 10, deleted: 0,
      startTS: 1327276800000, endTS: 1327708800000 },
    { top: true, bottom: false, grow: false });

  T.group('grow older again (refresh required)');
  // the old data is still an hour stale thanks to the young case above.
  testAccount.do_growFolderView(
    syncView, 7, false, 35,
    // Like the younger case, we get an extra flag refresh because our sync range
    // includes the oldest message known to us.
    { count: 7, full : 0, flags: 8, deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });


  T.group('shrink off old');
  testAccount.do_shrinkFolderView(
    syncView, 0, -2, 41, // -2 gets rid of 1, because it's inclusive
    { top: true, bottom: false, grow: false });
  testAccount.do_shrinkFolderView(
    syncView, 0, -21, 21, // -21 gets rid of 20, because it's inclusive
    { top: true, bottom: false, grow: false });

  T.group('grow old again (limited refresh)');
  // the time range of SINCE 1990 BEFORE Jan 11 is already refreshed, so this
  // gets clamped to SINCE Jan 11 BEFORE Jan 18.
  testAccount.do_growFolderView(
    syncView, 20, false, 21,
    { count: 20, full: 0, flags: 14, deleted: 0,
      startTS: 1326240000000, endTS: 1326844800000 },
    { top: true, bottom: false, grow: false });

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
      testAccount = T.actor('testAccount', 'A',
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
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.group('cleanup');
  testAccount.do_closeFolderView(syncView);
});


function run_test() {
  runMyTests(15);
}

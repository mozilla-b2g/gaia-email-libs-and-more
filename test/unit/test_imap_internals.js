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
    { top: true, bottom: true, grow: false });

  T.group('(cleanly) shutdown account, universe');
  testUniverse.do_saveState();
  testUniverse.do_shutdown();

  //////////////////////////////////////////////////////////////////////////////
  // Universe 2 : add messages
  T.group('U2 [add]: reload account, universe');
  // rebind to new universe / (loaded) account
  testUniverse = T.actor('testUniverse', 'U2');
  var TA2 = testAccount = T.actor('testAccount', 'A2',
                        { universe: testUniverse, restored: true });

  T.group('verify sync is not starting from scratch');
  var TF2 = testFolder = testAccount.do_useExistingFolder(
                           'test_internals', '#2', testFolder);
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

  //////////////////////////////////////////////////////////////////////////////
  // Universe 3 : delete messages
  T.group('U3 [delete]: reload account, universe');
  // rebind to new universe / (loaded) account
  var TU3 = testUniverse = T.actor('testUniverse', 'U3');
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
      TA3.eImapAccount.expect_runOp_begin('do', 'modtags');
      TA3.eImapAccount.expect_runOp_end('do', 'modtags');
    }

    // update our test's idea of what messages exist where.
    TF3.messages.splice(0, 1);
  });
  testAccount.do_viewFolder(
    're-syncs', testFolder,
    { count: 5, full: 0, flags: 5, deleted: 1 },
    { top: true, bottom: true, grow: false });

  T.group('save account state');
  testUniverse.do_saveState();

  T.group('(uncleanly) shutdown account, universe');
  // so, yeah, this is exactly like our clean shutdown, effectively...
  testUniverse.do_shutdown();

  //////////////////////////////////////////////////////////////////////////////
  // Universe 4 : change messages
  T.group('U4 [change]: reload account, universe');
  // rebind to new universe / (loaded) account
  var TU4 = testUniverse = T.actor('testUniverse', 'U4');
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
      // we had to latch TA2 because testAccount is updated statically
      TA4.eImapAccount.expect_runOp_begin('do', 'modtags');
      TA4.eImapAccount.expect_runOp_end('do', 'modtags');
    }
  });
  var TV4 = testAccount.do_openFolderView(
    're-syncs', testFolder,
    { count: 5, full: 0, flags: 5, deleted: 0 },
    { top: true, bottom: true, grow: false });
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
  var TU5 = testUniverse = T.actor('testUniverse', 'U5');
  testAccount = T.actor('testAccount', 'A5',
                        { universe: testUniverse, restored: true });
  var TF5 = testFolder = testAccount.do_useExistingFolder(
                           'test_internals', '#', testFolder);
  var TV5 = testAccount.do_openFolderView(
    're-syncs', testFolder,
    { count: 5, full: 0, flags: 5, deleted: 0 },
    { top: true, bottom: true, grow: false });

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
  testUniverse.do_adjustSyncValues({
    fillSize: 14,
    days: 7,
  });

  T.group('initial sync');
  // Create 3 time regions that sync's heuristics will view as sufficient for
  // initial sync and each growth (14 per week).
  var syncFolder = testAccount.do_createTestFolder(
    'test_sync_grow',
    { count: 42, age: { days: 1 }, age_incr: { days: 1 }, age_incr_every: 2 });
  var syncView = testAccount.do_openFolderView(
    'grower', syncFolder,
    { count: 14, full: 14, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: true });

  T.group('fail to grow older without request');
  testAccount.do_growFolderView(
    syncView, 1, false, 14,
    [],
    { top: true, bottom: true, grow: true }, { nosave: true });

  T.group('fail to grow older when offline');
  testUniverse.do_pretendToBeOffline(true);
  testAccount.do_growFolderView(
    syncView, 1, true, 14,
    [],
    { top: true, bottom: true, grow: true }, { nosave: true });
  testUniverse.do_pretendToBeOffline(false);

  T.group('grow older (sync more than requested)');
  // only ask for 11 messages, but sync 14.
  testAccount.do_growFolderView(
    syncView, 11, true, 14,
    { count: 11, full: 14, flags: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });
  T.group('grow older, get spare from last sync');
  // We're asking for 14 here, but we should just get a batch o3 the spare 3
  // from last time.  Because 1 of them happens on the oldest day of our time
  // range, our sync will exclude that day and we will only need to sync 2
  // headers even though we will hear back about all 3.
  testAccount.do_growFolderView(
    syncView, 14, false, 25,
    { count: 3, full: 0, flags: 2, deleted: 0 },
    { top: true, bottom: true, grow: true });
  T.group('grow older (normal)');
  testAccount.do_growFolderView(
    syncView, 14, true, 28,
    { count: 14, full: 14, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false });

  T.group('shrink off new');
  testAccount.do_shrinkFolderView(
    syncView, 1, null, 41,
    { top: false, bottom: true, grow: false });
  testAccount.do_shrinkFolderView(
    syncView, 14, null, 27,
    { top: false, bottom: true, grow: false });

  T.group('grow younger again');
  testAccount.do_growFolderView(
    syncView, -7, false, 34,
    [],
    { top: false, bottom: true, grow: false }, { nosave: true });
  testAccount.do_growFolderView(
    syncView, -8, false, 42,
    [],
    { top: true, bottom: true, grow: false }, { nosave: true });


  T.group('shrink off old');
  testAccount.do_shrinkFolderView(
    syncView, 0, -2, 41, // -2 gets rid of 1, because it's inclusive
    { top: true, bottom: false, grow: false });
  testAccount.do_shrinkFolderView(
    syncView, 0, -21, 21, // -21 gets rid of 20, because it's inclusive
    { top: true, bottom: false, grow: false });

  T.group('grow old again');
  // we will hear about 21 messages, but only 20 headers will need to be synced
  // because one of them is already covered by our sync's date range.
  testAccount.do_growFolderView(
    syncView, 21, false, 21,
    { count: 21, full: 0, flags: 20, deleted: 0 },
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
    { top: true, bottom: true, grow: false });

  T.group('cleanup');
  testAccount.do_closeFolderView(syncView);
});


function run_test() {
  runMyTests(15);
}

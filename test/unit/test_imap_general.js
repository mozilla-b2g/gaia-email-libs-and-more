/**
 * Test our IMAP sync logic under non-pathological conditions.  We exercise
 * logic with a reasonable number of messages.  Test cases that involve folders
 * with ridiculous numbers of messages and/or huge gaps in time which will take
 * a while to run and/or might upset the IMAP servers are/will be handled by
 * `test_imap_complex.js`.
 *
 * Our tests verify that:
 * - Live synchronization provides the expected results where the messages come
 *   direct from the connection as they are added.
 * - Listing the messages in an already synchronized folder when offline
 *   properly retrieves the messages.
 * - Resynchronizing an already-synchronized unchanged folder only issues
 *   the time-range search and flag fetches and returns the same set of
 *   messages.
 * - Resynchronizing an already-synchronized folder detects new messages,
 *   deleted messages, and flag changes.
 **/

load('resources/loggest_test_framework.js');

var TD = $tc.defineTestsFor(
  { id: 'test_imap_general' }, null, [$th_imap.TESTHELPER], ['app']);

const INITIAL_SYNC_DAYS = 5,
      // This is the number of messages after which the sync logic will
      // declare victory and stop filling.
      INITIAL_FILL_SIZE = 12;

TD.commonCase('folder sync', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A', { universe: testUniverse }),
      eSync = T.lazyLogger('sync');

  testUniverse.do_adjustSyncValues({
    fillSize: INITIAL_FILL_SIZE,
    days: INITIAL_SYNC_DAYS,
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
                            { top: true, bottom: true, grow: false },
                            { syncedToDawnOfTime: true });
  testUniverse.do_pretendToBeOffline(true);
  testAccount.do_viewFolder('checks persisted data of', emptyFolder,
                            { count: 0, full: 0, flags: 0, deleted: 0 },
                            { top: true, bottom: true, grow: false });
  testUniverse.do_pretendToBeOffline(false);
  testAccount.do_viewFolder('resyncs', emptyFolder,
                            { count: 0, full: 0, flags: 0, deleted: 0 },
                            { top: true, bottom: true, grow: false },
                            { syncedToDawnOfTime: true });

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
                            { top: true, bottom: true, grow: false },
                            { syncedToDawnOfTime: true });
  testUniverse.do_pretendToBeOffline(true);
  testAccount.do_viewFolder('checks persisted data of', fullSyncFolder,
                            { count: 4, full: 0, flags: 0, deleted: 0 },
                            { top: true, bottom: true, grow: false });
  testUniverse.do_pretendToBeOffline(false);
  testAccount.do_viewFolder('resyncs', fullSyncFolder,
                            { count: 4, full: 0, flags: 4, deleted: 0 },
                            { top: true, bottom: true, grow: false },
                            { syncedToDawnOfTime: true });

  /**
   * Perform a folder sync where our initial time fetch window contains more
   * messages than we want and there are even more messages before that time
   * window.
   */
  T.group('saturated initial interval');
  var saturatedFolder = testAccount.do_createTestFolder(
    'test_saturated_sync',
    { count: 17, age: { days: 1 }, age_incr: { days: 1 }, age_incr_every: 3 });
  testAccount.do_viewFolder(
    'syncs', saturatedFolder,
    { count: INITIAL_FILL_SIZE, full: 15, flags: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });
  testUniverse.do_pretendToBeOffline(true);
  // We get all the headers in one go because we are offline, and they get
  // thresholded to the initial fill size.
  testAccount.do_viewFolder('checks persisted data of', saturatedFolder,
    { count: INITIAL_FILL_SIZE, full: 0, flags: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });
  testUniverse.do_pretendToBeOffline(false);
  // this is a refresh now, so we only refresh the date range covered by
  // initial fill.  This used to be a day-based sync for the 5 sync days,
  // so 15 flags instead of 12.
  testAccount.do_viewFolder(
    'resyncs', saturatedFolder,
    { count: INITIAL_FILL_SIZE, full: 0, flags: INITIAL_FILL_SIZE, deleted: 0 },
    { top: true, bottom: false, grow: false });

  /**
   * Perform a folder sync where we need to search multiple time ranges in order
   * to gain a sufficient number of messages.
   */
  T.group('initial fetch spans multiple time ranges');
  var msearchFolder = testAccount.do_createTestFolder(
    'test_multiple_ranges', // (insert one more than we want to find)
    { count: 13, age: { days: 1 }, age_incr: { days: 1 } });
  testAccount.do_viewFolder(
    'syncs', msearchFolder,
    [{ count: 5, full: 5, flags: 0, deleted: 0 },
     { count: 5, full: 5, flags: 0, deleted: 0 },
     { count: 2, full: 3, flags: 0, deleted: 0 }],
    { top: true, bottom: false, grow: false },
    { syncedToDawnOfTime: true });
  testUniverse.do_pretendToBeOffline(true);
  // We get all the headers in one go because we are offline, and they get
  // thresholded to the initial fill size.
  testAccount.do_viewFolder('checks persisted data of', msearchFolder,
    { count: INITIAL_FILL_SIZE, full: 0, flags: 0, deleted: 0 },
    { top: true, bottom: false, grow: false });
  testUniverse.do_pretendToBeOffline(false);
  // this used to be [5, 5, 2] like the initial sync.  Now it's just a refresh.
  testAccount.do_viewFolder(
    'resyncs', msearchFolder,
    [{ count: 12, full: 0, flags: 12, deleted: 0 }],
    { top: true, bottom: false, grow: false });

  /**
   * Use our mutation mechanism with speculative application disabled in order
   * to cause some apparent flag changes and deletions to occur.
   */
  T.group('sync detects additions/modifications/deletions');
  // delete 2 from the first interval (of 7), 1 from the second (of 7)
  testAccount.do_manipulateFolder(msearchFolder, 'nolocal', function(slice) {

    MailAPI.modifyMessageTags([slice.items[1]], ['\\Deleted'], null, 'delete');
    MailAPI.modifyMessageTags([slice.items[2], slice.items[8]],
                              ['\\Deleted'], null, 'delete');
    slice.items[3].setRead(true);
    slice.items[4].setStarred(true);

    for (var i = 0; i < 4; i++) {
      testAccount.expect_runOp('modtags',
                               { local: false, server: true, save: false });
    }

    // update our test's idea of what messages exist where.
    msearchFolder.beAwareOfDeletion(8);
    msearchFolder.beAwareOfDeletion(2);
    msearchFolder.beAwareOfDeletion(1);
  });
  // add messages (4, 3) to (5-2=3, 5-1=4) so our fetches become: 7, 7
  // (and we are no longer covering all known messages)
  testAccount.do_addMessagesToFolder(
    msearchFolder,
    { count: 7, age: { days: 2 }, age_incr: { days: 1 } });
  // - open view, checking refresh, and _leave it open_ for the next group
  // the refresh will see everything at once; this used to be: 7/4/3/2,
  // 7/3/4/1.  The refresh will fully span all known messages because the
  // 7 new messages are interspersed among the known messages and this is a
  // refresh that does not overflow, not a deepening sync.
  var msearchView = testAccount.do_openFolderView(
    'msearch', msearchFolder,
    // because the new messages are interleaved rather than at the end, we will
    // end up with more than 12/INITIAL_FILL_SIZE in the second case.
    [{ count: 16, full: 7, flags: 9, deleted: 3 }],
    { top: true, bottom: false, grow: false });

  /**
   * Perform some manipulations with the view still open, then trigger a refresh
   * and make sure the view updates correctly.
   */
  T.group('sync refresh detects mutations and updates in-place');
  var expectedRefreshChanges = {
    changes: [],
    deletions: [],
  };
  testAccount.do_manipulateFolderView(
    msearchView, 'nolocal',
    function(slice) {
      expectedRefreshChanges.deletions.push(slice.items[8]);
      MailAPI.modifyMessageTags([slice.items[8]],
                                ['\\Deleted'], null, 'delete');
      expectedRefreshChanges.deletions.push(slice.items[0]);
      MailAPI.modifyMessageTags([slice.items[0]],
                                ['\\Deleted'], null, 'delete');

      expectedRefreshChanges.changes.push([slice.items[9], 'isRead', true]);
      slice.items[9].setRead(true);

      expectedRefreshChanges.changes.push([slice.items[10], 'isStarred', true]);
      slice.items[10].setStarred(true);

      msearchFolder.beAwareOfDeletion(8);
      msearchFolder.beAwareOfDeletion(0);
    });
  testAccount.do_refreshFolderView(
    msearchView,
    // Our expectations happen in a single go here because the refresh covers
    // the entire date range in question.
    { count: 14, full: 0, flags: 14, deleted: 2 },
    expectedRefreshChanges,
    { top: true, bottom: false, grow: false });

  T.group('get the message body for an existing message');
  T.action(eSync, 'request message body from', msearchView, function() {
    // Pick an index that's not the first one of anything...
    var index = 5,
        synMessage = msearchView.testFolder.knownMessages[index];
    eSync.expect_namedValue(
      'bodyInfo',
      {
        to: synMessage.bodyInfo.to,
        bodyReps: synMessage.bodyInfo.bodyReps,
      });

    var header = msearchView.slice.items[index];
    header.getBody(function(bodyInfo) {
      eSync.namedValue(
        'bodyInfo',
        bodyInfo && {
          to: bodyInfo.to,
          bodyReps: bodyInfo.bodyReps,
        });
      bodyInfo.die();
    });
  });

  T.group('fail to get the message body for a deleted message');
  T.action(eSync, 'request deleted message body from',
           msearchFolder.storageActor, function() {
    eSync.expect_namedValue('bodyInfo', null);
    msearchFolder.storageActor.expect_bodyNotFound();
    var deletedHeader = expectedRefreshChanges.deletions[0];
    deletedHeader.getBody(function(bodyInfo) {
      eSync.namedValue('bodyInfo', bodyInfo);
      // it's null so we don't call bodyInfo.die(), but if it wasn't...!
    });
  });

  T.group('cleanup');
  testAccount.do_closeFolderView(msearchView);
});

function run_test() {
  runMyTests(20); // we do a lot of appending...
}

/**
 * Test our IMAP sync logic under non-pathological conditions.  We exercise
 * logic with a reasonable number of messages.  Test cases that involve folders
 * with ridiculous numbers of messages and/or huge gaps in time which will take
 * a while to run and/or might upset the IMAP servers are handled in
 * `test_imap_excessive.js`.
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

// This needs to match up with what the app is currently using right now, but we
// should probably just clobber the internal constant via a debugging hook if
// we change it.
//
// This really means 7.5 days
const INITIAL_SYNC_DAYS = 7,
      // This is the number of messages after which the sync logic will
      // declare victory and stop filling.
      INITIAL_FILL_SIZE = 15;

TD.commonCase('folder sync', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A', { universe: testUniverse }),
      eSync = T.lazyLogger('sync');

  /**
   * Try and synchronize an empty folder.  Verify that our slice completes with
   * minimal legwork.
   */
  T.group('sync empty folder');
  var emptyFolder = testAccount.do_createTestFolder(
    'test_empty_sync', { count: 0 });
  testAccount.do_viewFolder('syncs', emptyFolder,
                            { count: 0, full: 0, flags: 0, deleted: 0 });
  testAccount.do_pretendToBeOffline(true);
  testAccount.do_viewFolder('checks persisted data of', emptyFolder,
                            { count: 0, full: 0, flags: 0, deleted: 0 });
  testAccount.do_pretendToBeOffline(false);
  testAccount.do_viewFolder('resyncs', emptyFolder,
                            { count: 0, full: 0, flags: 0, deleted: 0 });

  /**
   * Perform a folder sync where our initial time fetch window contains all of
   * the messages in the folder.
   */
  T.group('initial interval is full sync');
  var fullSyncFolder = testAccount.do_createTestFolder(
    'test_initial_full_sync',
    { count: 4, age: { days: 0 }, age_incr: { days: 1 } });
  testAccount.do_viewFolder('syncs', fullSyncFolder,
                            { count: 4, full: 4, flags: 0, deleted: 0 });
  testAccount.do_pretendToBeOffline(true);
  testAccount.do_viewFolder('checks persisted data of', fullSyncFolder,
                            { count: 4, full: 0, flags: 0, deleted: 0 });
  testAccount.do_pretendToBeOffline(false);
  testAccount.do_viewFolder('resyncs', fullSyncFolder,
                            { count: 4, full: 0, flags: 4, deleted: 0 });

  /**
   * Perform a folder sync where our initial time fetch window contains more
   * messages than we want and there are even more messages beyond.
   */
  T.group('saturated initial interval');
  var saturatedFolder = testAccount.do_createTestFolder(
    'test_saturated_sync',
    { count: 21, age: { days: 0 }, age_incr: { hours: 9.1 } });
  // This should provide 20 messages in our 7.5 day range.  (9 hours makes it
  // line up perfectly so we actually get 21, which is not what we want.)
  testAccount.do_viewFolder('syncs', saturatedFolder,
                            { count: 20, full: 20, flags: 0, deleted: 0 });
  testAccount.do_pretendToBeOffline(true);
  testAccount.do_viewFolder('checks persisted data of', saturatedFolder,
                            { count: 20, full: 0, flags: 0, deleted: 0 });
  testAccount.do_pretendToBeOffline(false);
  testAccount.do_viewFolder('resyncs', saturatedFolder,
                            { count: 20, full: 0, flags: 20, deleted: 0 });

  /**
   * Perform a folder sync where we need to search multiple time ranges in order
   * to gain a sufficient number of messages.
   */
  T.group('initial fetch spans multiple time ranges');
  var msearchFolder = testAccount.do_createTestFolder(
    'test_multiple_ranges', // (insert one more than we want to find)
    { count: 19, age: { days: 0, hours: 1 }, age_incr: { days: 2 } });
  // will fetch: 4, 7, 7 = 18
  testAccount.do_viewFolder('syncs', msearchFolder,
                            [{ count: 4, full: 4, flags: 0, deleted: 0 },
                             { count: 7, full: 7, flags: 0, deleted: 0 },
                             { count: 7, full: 7, flags: 0, deleted: 0 }]);
  testAccount.do_pretendToBeOffline(true);
  testAccount.do_viewFolder('checks persisted data of', msearchFolder,
                            // Distinct date ranges are not required since we
                            // are offline...
                            { count: 18, full: 0, flags: 0, deleted: 0 });
  testAccount.do_pretendToBeOffline(false);
  testAccount.do_viewFolder('resyncs', msearchFolder,
                            [{ count: 4, full: 0, flags: 4, deleted: 0 },
                             { count: 7, full: 0, flags: 7, deleted: 0 },
                             { count: 7, full: 0, flags: 7, deleted: 0 }]);

  /**
   * Use our mutation mechanism with speculative application disabled in order
   * to cause some apparent flag changes and deletions to occur.
   */
  T.group('sync detects additions/modifications/deletions');
  // delete 2 from the first interval (of 4), 1 from the second (of 7)
  testAccount.do_manipulateFolder(msearchFolder, 'nolocal', function(slice) {
    slice.items[1].deleteMessage();
    MailAPI.deleteMessages([slice.items[2], slice.items[5]]);
    slice.items[3].setRead(true);
    slice.items[4].setStarred(true);

    // update our test's idea of what messages exist where.
    msearchFolder.messages.splice(5, 1);
    msearchFolder.messages.splice(2, 1);
    msearchFolder.messages.splice(1, 1);
  });
  // add messages (4, 3) so our fetches become: 6, 12 = 18
  testAccount.do_addMessagesToFolder(
    msearchFolder,
    { count: 10, age: { days: 0 }, age_incr: { days: 2 } });
  // - open view, checking refresh, and _leave it open_ for the next group
  var msearchView = testAccount.do_openFolderView(
    'msearch', msearchFolder,
    [{ count: 6, full: 4, flags: 2, deleted: 2 },
     { count: 12, full: 6, flags: 6, deleted: 1 }]);

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
      slice.items[8].deleteMessage();
      expectedRefreshChanges.deletions.push(slice.items[0]);
      slice.items[0].deleteMessage();

      expectedRefreshChanges.changes.push([slice.items[12], 'isRead', true]);
      slice.items[12].setRead(true);

      expectedRefreshChanges.changes.push([slice.items[13], 'isStarred', true]);
      slice.items[13].setStarred(true);

      msearchFolder.messages.splice(8, 1);
      msearchFolder.messages.splice(0, 1);
    });
  testAccount.do_refreshFolderView(
    msearchView,
    // Our expectations happen in a single go here because the refresh covers
    // the entire date range in question.
    { count: 16, full: 0, flags: 16, deleted: 2 },
    expectedRefreshChanges);

  T.group('get the message body for an existing message');
  T.action(eSync, 'request message body from', msearchView, function() {
    // Pick an index that's not the first one of anything...
    var index = 5,
        synMessage = msearchView.testFolder.messages[index];
    eSync.expect_namedValue(
      'bodyInfo',
      {
        to: synMessage.bodyInfo.to,
        bodyText: synMessage.bodyInfo.bodyText,
      });

    var header = msearchView.slice.items[index];
    header.getBody(function(bodyInfo) {
      eSync.namedValue(
        'bodyInfo',
        bodyInfo && {
          to: bodyInfo.to,
          bodyText: bodyInfo.bodyText,
        });
    });
  });

  T.group('fail to get the message body for a deleted message');
  T.action(eSync, 'request deleted message body from', msearchView,
           msearchFolder.storageActor, function() {
    eSync.expect_namedValue('bodyInfo', null);
    msearchFolder.storageActor.expect_bodyNotFound();
    var deletedHeader = expectedRefreshChanges.deletions[0];
    deletedHeader.getBody(function(bodyInfo) {
      eSync.namedValue('bodyInfo', bodyInfo);
    });
  });

  T.group('cleanup');
  testAccount.do_closeFolderView(msearchView);
});

function run_test() {
  runMyTests(20); // we do a lot of appending...
}

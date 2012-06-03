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
  { id: 'blah' }, null, [$th_imap.TESTHELPER], ['app']);

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
  var testAccount = T.actor('testImapAccount', 'A'),
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
    { count: 21, age: { days: 0 }, age_incr: { hours: 9 } });
  // This should provide 20 messages in our 7.5 day range.
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
    'test_multiple_ranges',
    { count: 19, age: { days: 0, hours: 1 }, age_incr: { days: 2 } });
  // will fetch: 4, 7, 7 = 18
  testAccount.do_viewFolder('syncs', msearchFolder,
                            { count: 19, full: 19, flags: 0, deleted: 0 });
  testAccount.do_pretendToBeOffline(true);
  testAccount.do_viewFolder('checks persisted data of', msearchFolder,
                            { count: 19, full: 0, flags: 0, deleted: 0 });
  testAccount.do_pretendToBeOffline(false);
  testAccount.do_viewFolder('resyncs', msearchFolder,
                            { count: 19, full: 0, flags: 19, deleted: 0 });

  /**
   * Use our mutation mechanism with speculative application disabled in order
   * to cause some apparent flag changes and deletions to occur.
   */
  T.group('sync detects additions/modifications/deletions');
  // delete 2 from the first interval (of 4), 1 from the second (of 7)
  testAccount.do_manipulateFolder(msearchFolder, function(slice) {
    slice.items[1].deleteMessage();
    MailAPI.deleteMessages([slice.items[2], slice.items[5]]);
    slice.items[3].setRead(true);
    slice.items[4].setStarred(true);
  });
  // add messages so our fetches become: 6, 9 = 17
  testAccount.do_addMessagesToFolder(
    msearchFolder,
    { count: 7, age: { days: 0 }, age_incr: { days: 2 } });
  var msearchView = testAccount.do_openFolderView(
    'msearch', msearchFolder,
    { count: 17, full: 7, flags: 10, deleted: 3 });

  /**
   * Perform some manipulations with the view still open, then trigger a refresh
   * and make sure the view updates correctly.
   */
  T.group('sync refresh detections mutations and updates in-place');
  testAccount.do_manipulateFolderView(
    msearchView,
    function(slice) {
    });
  testAccount.do_refreshFolderView(
    msearchView,
    { count: 17, full: 0, flags: 17, deleted: 0 },
    function(slice) {

    });
  testAccount.do_closeFolderView(msearchView);

  T.group('cleanup');
});

function run_test() {
  runMyTests(20); // we do a lot of appending...
}

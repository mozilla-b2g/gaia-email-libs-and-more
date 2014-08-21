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
 **/

define(['rdcommon/testcontext', './resources/th_main',
        './resources/messageGenerator', 'exports'],
       function($tc, $th_imap, $msggen, exports) {

var TD = exports.TD = $tc.defineTestsFor(
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
  testAccount.do_viewFolder(
    'syncs', emptyFolder,
    { count: 0, full: 0, flags: 0, deleted: 0 },
    // initial syncs do not report 'new' messages since they're all new
    { top: true, bottom: true, grow: false, newCount: null },
    { syncedToDawnOfTime: true });
  testUniverse.do_pretendToBeOffline(true);
  testAccount.do_viewFolder(
    'checks persisted data of', emptyFolder,
    { count: 0, full: 0, flags: 0, deleted: 0 },
    // offline syncs do not report 'new' messages since no sync happens!
    { top: true, bottom: true, grow: false, newCount: null });
  testUniverse.do_pretendToBeOffline(false);
  testAccount.do_viewFolder(
    'resyncs', emptyFolder,
    { count: 0, full: 0, flags: 0, deleted: 0 },
    // refreshes do report new messages; but we have none
    { top: true, bottom: true, grow: false, newCount: 0 },
    { syncedToDawnOfTime: true });

  /**
   * Perform a folder sync where our initial time fetch window contains all of
   * the messages in the folder.
   */
  T.group('initial interval is full sync');
  var fullSyncFolder = testAccount.do_createTestFolder(
    'test_initial_full_sync',
    { count: 4, age: { days: 0 }, age_incr: { days: 1 } });
  testAccount.do_viewFolder(
    'syncs', fullSyncFolder,
    { count: 4, full: 4, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: null },
    { syncedToDawnOfTime: true });
  testUniverse.do_pretendToBeOffline(true);
  testAccount.do_viewFolder(
    'checks persisted data of', fullSyncFolder,
    { count: 4, full: 0, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: null });
  testUniverse.do_pretendToBeOffline(false);
  testAccount.do_viewFolder(
    'resyncs', fullSyncFolder,
    { count: 4, full: 0, flags: 4, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: 0 },
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
    { top: true, bottom: false, grow: false, newCount: null });
  testUniverse.do_pretendToBeOffline(true);
  // We get all the headers in one go because we are offline, and they get
  // thresholded to the initial fill size.
  testAccount.do_viewFolder('checks persisted data of', saturatedFolder,
    { count: INITIAL_FILL_SIZE, full: 0, flags: 0, deleted: 0 },
    { top: true, bottom: false, grow: false, newCount: null });
  testUniverse.do_pretendToBeOffline(false);
  // this is a refresh now, so we only refresh the date range covered by
  // initial fill.  This used to be a day-based sync for the 5 sync days,
  // so 15 flags instead of 12.
  testAccount.do_viewFolder(
    'resyncs', saturatedFolder,
    { count: INITIAL_FILL_SIZE, full: 0, flags: INITIAL_FILL_SIZE, deleted: 0 },
    { top: true, bottom: false, grow: false, newCount: 0 });

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
    { top: true, bottom: false, grow: false, newCount: null },
    { syncedToDawnOfTime: true });
  testUniverse.do_pretendToBeOffline(true);
  // We get all the headers in one go because we are offline, and they get
  // thresholded to the initial fill size.
  testAccount.do_viewFolder('checks persisted data of', msearchFolder,
    { count: INITIAL_FILL_SIZE, full: 0, flags: 0, deleted: 0 },
    { top: true, bottom: false, grow: false, newCount: null });
  testUniverse.do_pretendToBeOffline(false);

  T.group('cleanup');
});

}); // end define

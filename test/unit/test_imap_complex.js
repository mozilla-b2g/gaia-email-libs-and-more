/**
 * Test more complicated IMAP sync scenarios, primarily nuances of growth and
 * refresh, but also covering edge cases.
 **/

load('resources/loggest_test_framework.js');

var TD = $tc.defineTestsFor(
  { id: 'test_imap_complex' }, null, [$th_imap.TESTHELPER], ['app']);

// This gets clobbered into $mailslice by testhelper.js as a default.
// This really means 7.5 days
const INITIAL_SYNC_DAYS = 7,
      // This is the number of messages after which the sync logic will
      // declare victory and stop filling.
      INITIAL_FILL_SIZE = 15;

/**
 * In the new only-refresh world view, the key things to check:
 * - We do/don't refresh if our time threshold says we should/shouldn't when
 *   opening a slice.
 * - We do/don't refresh when growing based on our time threshold.
 * - When our refresh is confronted with too many messages, the bisection logic
 *   properly kicks in to cover the entire range.
 * - When growing with refresh to cover known messages, we still check days
 *   that we didn't have any messages in one of our refreshes.  (So if we are
 *   showing Wednesday, our first previous messages are on Monday, our grow's
 *   refresh will cover Tuesday and not result in a gap.)
 */
TD.commonCase('sliceOpenMostRecent', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A', { universe: testUniverse }),
      eSync = T.lazyLogger('sync');

  /**
   * NB: This test originally tested our much more complicated sync logic,
   * and has been simplified, but not re-written from scratch.  So some things
   * like time-warps that seem like they have real intent behind them are no
   * longer of great concern.
   *
   * General setup:
   *
   * - Create Nsync messages spread over 3 sync intervals, the first of which is
   *   6 sync intervals in the past (but more recent than the old threshold).
   *   Also create Nsync messages further back in time before those that we
   *   never get to, but which are there to get accidentally synced if we screw
   *   up.
   *
   * (We alter time by changing when the perceived value of 'now' is.  All
   *  code does TIME_WARPED_NOW || Date.now() rather than just Date.now().  To
   *  avoid needlessly breaking our logic we only ever increase the time value.)
   *
   * "nothing has changed since last time"
   *
   * - Perform an initial open sync which does our deepening strategy.
   * - Perform an open without having exceeded the refresh threshold; verify
   *   that we get the contents of the folder without using our network
   *   connection.
   * - Time jump, perform an open, verify that a refresh happens.
   * - Big time jump, perform an open sync, verifying this is still a refresh
   *   too.  (This is largely a holdover from our old tests, but does help
   *   ensure our old heuristics are dead.)
   *
   * "minimal changes we expected have happened"
   *
   * - Add a message.
   * - Verify that a slice open without having crossed the threshold only tells
   *   us about what we already know about and there is no network traffic.
   * - Timewarp so we want to refresh, open the slice, verify a refresh with the
   *   new message coming last.
   * - Add another message, verify a sync refresh with still only fill-size
   *   retrieved and the new message coming last.
   *
   *
   * "oh no, lots of new messages"
   *
   * - Adjust overflow values, create a new folder with the same heuristics
   *   as before.
   * - Perform initial deepening sync.
   * - Add enough messages to trigger overflow conditions on the refresh and
   *   a subsequent naive date sync for expanding the range.
   * - Perform a refreshing open; observe the aborted refresh sync which is
   *   replaced by a series of smaller syncs along the lines of a deepening
   *   sync.  The main difference is that our bisection logic is used to
   *   determine how many days we start out with.
   **/

  // Jan 28th, yo.  Intentionally avoiding dalight saving time
  // Static in the sense that we vary over the course of this defining function
  // rather than varying during dynamically during the test functions as they
  // run.
  var staticNow = new Date(2012, 0, 28, 12, 0, 0).valueOf();

  const MINUTE_MILLIS = 60 * 1000, HOUR_MILLIS = 60 * MINUTE_MILLIS,
        DAY_MILLIS = 24 * HOUR_MILLIS;
  const TSYNCI = 3;
  testUniverse.do_adjustSyncValues({
    fillSize: 3 * TSYNCI,
    days: TSYNCI,
    // never grow the sync interval!
    scaleFactor: 1,
    bisectThresh: 15,
    tooMany: 2000,

    // set the refresh threshold at 30 minutes so advancing an hour will
    // cause a refresh to trigger.
    openRefreshThresh: 30 * MINUTE_MILLIS,
    growRefreshThresh: 30 * MINUTE_MILLIS,
  });

  T.group('no change: setup');
  testUniverse.do_timewarpNow(staticNow, 'Jan 28th noon');
  var createdAt = staticNow;
  var c1Folder = testAccount.do_createTestFolder(
    'test_complex_old1',
    // we will sync 9, leave an extra 1 not to sync so grow is true.
    { count: 10, age: { days: 6 * TSYNCI + 1 }, age_incr: { days: 1 } });
  testAccount.do_viewFolder(
    'syncs', c1Folder,
    [{ count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 3, full: 3, flags: 0, deleted: 0 },
     { count: 3, full: 3, flags: 0, deleted: 0 },
     { count: 3, full: 3, flags: 0, deleted: 0 }],
    { top: true, bottom: true, grow: true });

  T.group('no change: refresh');
  testAccount.do_viewFolder(
    'show no refresh', c1Folder,
    { count: 9, full: 0, flags: 9, deleted: 0 },
    { top: true, bottom: true, grow: true },
    { nonet: true });
  staticNow += HOUR_MILLIS;
  testUniverse.do_timewarpNow(staticNow, '+1 hour');
  testAccount.do_viewFolder(
    'sync refresh', c1Folder,
    { count: 9, full: 0, flags: 9, deleted: 0 },
    { top: true, bottom: true, grow: true });

  T.group('no change: still refresh after timewarp');
  // Jump time so that the messages are just under the old threshold.  They
  // are already 6 time intervals in the past, but we want them at 15, so
  // add 9 TSYNCI less 0.5 days.
  staticNow = createdAt +
              ((9 * TSYNCI) + 1.5) * DAY_MILLIS;
  testUniverse.do_timewarpNow(staticNow, '9 TSYNCI + 1.5 days out');
  testAccount.do_viewFolder(
    'sync refresh', c1Folder,
    { count: 9, full: 0, flags: 9, deleted: 0 },
    { top: true, bottom: true, grow: true });


  T.group('minimal changes: add, no refresh, sync refresh');
  testAccount.do_addMessagesToFolder(
    c1Folder,
    { count: 1, age: { days: 1 } });
  testAccount.do_viewFolder(
    'show no refresh', c1Folder,
    { count: 9, full: 0, flags: 9, deleted: 0 },
    { top: true, bottom: true, grow: true },
    { nonet: true });
  staticNow += HOUR_MILLIS;
  testUniverse.do_timewarpNow(staticNow, '+1 hour');
  testAccount.do_viewFolder(
    'sync refresh', c1Folder,
    { count: 10, full: 1, flags: 9, deleted: 0 },
    { top: true, bottom: true, grow: true });


  T.group('minimal changes: add, sync refresh, still 9 base');
  testAccount.do_addMessagesToFolder(
    c1Folder,
    { count: 1, age: { days: 1 } });
  staticNow += 3 * HOUR_MILLIS;
  testUniverse.do_timewarpNow(staticNow, '+3 hours');
  testAccount.do_viewFolder(
    'sync refresh', c1Folder,
    { count: 10, full: 1, flags: 9, deleted: 0 },
    { top: true, bottom: false, grow: false });


  T.group('lots of messages: setup');
  // May 28th, intentionally staying far away from daylight savings time.
  staticNow = new Date(2012, 4, 28, 12, 0, 0).valueOf();
  testUniverse.do_timewarpNow(staticNow, 'May 28th noon-ish');
  createdAt = staticNow;
  var c2Folder = testAccount.do_createTestFolder(
    'test_complex_old2',
    { count: 9, age: { days: 7 * TSYNCI + 1 }, age_incr: { days: 1 } });
  testAccount.do_viewFolder(
    'syncs', c2Folder,
    [{ count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 3, full: 3, flags: 0, deleted: 0 },
     { count: 3, full: 3, flags: 0, deleted: 0 },
     { count: 3, full: 3, flags: 0, deleted: 0 }],
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.group('lots of messages: refresh open with overflow');
  testAccount.do_addMessagesToFolder(
    c2Folder,
    { count: 21, age: { days: 1 }, age_incr: { days: 1 } });
  staticNow += HOUR_MILLIS;
  testUniverse.do_timewarpNow(staticNow, '+1 hour');
  var f2View = testAccount.do_openFolderView(
    'bisecting sync refresh', c2Folder,
    // Because of the overflow, we trigger bisection logic, so this sync
    // gets aborted which logs all null values:
    [{ count: 0, full: null, flags: null, deleted: null,
       startTS: 631152000000, endTS: 1338249600000 },
    // The bisection logic falls back from the 'all of time ever' case,
    // dropping down to the hardcoded 30 day limit.
    // Our shrink scale ends up(BISECT_DATE_AT_N_MESSAGES / (numHeaders * 2))
    // === (15 / (30 * 2)) === 0.25.  We were scanning 30 days, so we end up
    // with 7.5 => 8 days of stepping.  Because we generated the messages
    // offset by 1 day, this means 7 new messages.
     { count: 7, full: 7, flags: 0, deleted: 0,
       startTS: 1337558400000, endTS: 1338249600000 },
    // and then 8 because there is no skipped day in this range
     { count: 8, full: 8, flags: 0, deleted: 0,
       startTS: 1336176000000, endTS: 1336867200000 },
    // and then we overlap with the already known messages.  Note that although
    // onSyncCompleted can now conclude that it knows about the existence of
    // all the messages in the folder, it can't conclude that the flags are
    // up-to-date, so it will be forced to issue an additional search to get
    // those flags.
     { count: 8, full: 6, flags: 2, deleted: 0,
       startTS: 1336176000000, endTS: 1336867200000 },

     { count: 7, full: 0, flags: 7, deleted: 0,
       startTS: 1336176000000, endTS: 1336867200000 }],
    // This will result in us covering the entire span, so we will be at the
    // bottom too.
    { top: true, bottom: true, grow: false },
    { extraMutex: 'sync', syncedToDawnOfTime: true });

  T.group('cleanup');
});

/**
 * If there are more messages in the sync range than the initial fill desires,
 * it's important that the sync routine still gets presented with all the
 * headers covering the time range.  As a real example, our initial sync range
 * had 22 messages in it, but the initial fill was 15, so when doing a refresh
 * we would see 7 new messages.  Things would then break when tried to insert
 * the duplicate messages.
 *
 * For our test, we choose an initial sync of 3 days, a fill size of 4 messages,
 * and we just cram 6 messages in one day.
 */
TD.commonCase('refresh does not break when db limit hit', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('sync');

  // Jan 28th, yo.  Intentionally avoiding dalight saving time
  // Static in the sense that we vary over the course of this defining function
  // rather than varying during dynamically during the test functions as they
  // run.
  var staticNow = new Date(2012, 0, 28, 12, 0, 0).valueOf();

  const HOUR_MILLIS = 60 * 60 * 1000, DAY_MILLIS = 24 * HOUR_MILLIS;
  const TSYNCI = 3;
  testUniverse.do_adjustSyncValues({
    fillSize: 4,
    days: TSYNCI,
    // never grow the sync interval!
    scaleFactor: 1,
    bisectThresh: 2000,
    tooMany: 2000,
    // The exact thresholds do not matter...
    refreshNonInbox: 2 * HOUR_MILLIS,
    refreshInbox: 2 * HOUR_MILLIS,
    // But this does; be older than our #1 and #2 triggering cases
    oldIsSafeForRefresh: 15 * TSYNCI * DAY_MILLIS,
    refreshOld: 2 * DAY_MILLIS,

    useRangeNonInbox: 4 * HOUR_MILLIS,
    useRangeInbox: 4 * HOUR_MILLIS,
  });

  T.group('no change: setup');
  testUniverse.do_timewarpNow(staticNow, 'Jan 28th noon-ish');
  var testFolder = testAccount.do_createTestFolder(
    'test_complex_refresh',
    { count: 6, age: { days: 1 }, age_incr: { hours: 1 } });
  testAccount.do_viewFolder(
    'syncs', testFolder,
    [{ count: 4, full: 6, flags: 0, deleted: 0 }],
    // This is a deepening; we can tell because endTS-startTS is 4 days
    { top: true, bottom: false, grow: false,
      startTS: 1327449600000, endTS: 1327795200000 },
    { syncedToDawnOfTime: true });

  T.group('no change: refresh');
  staticNow += HOUR_MILLIS;
  testUniverse.do_timewarpNow(staticNow, '+1 hour');
  testAccount.do_viewFolder(
    '#1 refresh sync', testFolder,
    { count: 4, full: 0, flags: 6, deleted: 0 },
    // This is a refresh; we can tell because the startTS is based on the
    // oldest message in our slice.  The endTS is no clamped like this because
    // it expands the refresh range into the future (which is the same future
    // as we used when we opened the folder, because of quantization.)
    { top: true, bottom: false, grow: false,
      startTS: 1327622400000, endTS: 1327795200000},
    { syncedToDawnOfTime: true });

  T.group('cleanup');
});

/**
 * We sync based on day boundaries, but we provide messages to the UI based on
 * message counts.  Our goal here is to make sure that:
 *
 * - We do not attempt to re-synchronize a just-synchronized date range.
 * - Those 'remainder' messages that were already synchronized still get
 *   returned when growth is requested, and do not fall into cracks.
 */
TD.commonCase('just-synced headers returned without re-refresh', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('sync');

  // Jan 28th, yo.  Intentionally avoiding daylight saving time
  // Static in the sense that we vary over the course of this defining function
  // rather than varying during dynamically during the test functions as they
  // run.
  var staticNow = new Date(2012, 0, 28, 12, 0, 0).valueOf();

  const HOUR_MILLIS = 60 * 60 * 1000, DAY_MILLIS = 24 * HOUR_MILLIS;
  const TSYNCI = 4;
  testUniverse.do_adjustSyncValues({
    fillSize: 3,
    days: TSYNCI,
    // never grow the sync interval!
    scaleFactor: 1,
    bisectThresh: 2000,
    tooMany: 2000,
    // The exact thresholds do not matter...
    refreshNonInbox: 2 * HOUR_MILLIS,
    refreshInbox: 2 * HOUR_MILLIS,
    // But this does; be older than our #1 and #2 triggering cases
    oldIsSafeForRefresh: 15 * TSYNCI * DAY_MILLIS,
    refreshOld: 2 * DAY_MILLIS,

    useRangeNonInbox: 4 * HOUR_MILLIS,
    useRangeInbox: 4 * HOUR_MILLIS,
  });

  T.group('initial sync/view');
  testUniverse.do_timewarpNow(staticNow, 'Jan 28th noon-ish');
  var testFolder = testAccount.do_createTestFolder(
    'test_complex_no_skip_synced',
    { count: 6, age: { hours: 1 }, age_incr: { days: 1 }, age_incr_every: 2 });
  var folderView = testAccount.do_openFolderView(
    'syncs', testFolder,
    [{ count: 3, full: 6, flags: 0, deleted: 0 }],
    { top: true, bottom: false, grow: false },
    { syncedToDawnOfTime: true });

  T.group('grow');
  testAccount.do_growFolderView(
    folderView, 3, false, 3,
    // no refresh is required! everything is already synced! 3 from the db.
    3,
    { top: true, bottom: true, grow: false });

  T.group('cleanup');
});

/**
 * We keep going back further in time until we think we know about all the
 * messages or we hit 1990.  We believe we know all the messages when the
 * number of messages in the folder per EXISTS is the same as the number of
 * messages in our database and our sync time range covers the oldest message
 * in the database.
 */
TD.commonCase('do not sync earlier than 1990', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('sync');

  const HOUR_MILLIS = 60 * 60 * 1000, DAY_MILLIS = 24 * HOUR_MILLIS;
  //
  testUniverse.do_adjustSyncValues({
    fillSize: 4,
    // we want to maximize our search ranges so we get to 1990 faster
    days: 30,
    scaleFactor: 100,
    bisectThresh: 2000,
    tooMany: 2000,
    // set all the time offsets to really low values so we are sure to not
    // trigger them after the time-warp.
    refreshNonInbox: 1,
    refreshInbox: 1,
    oldIsSafeForRefresh: 1,
    refreshOld: 1,

    useRangeNonInbox: 1,
    useRangeInbox: 1,
  });

  T.group('make there be 1 unexpunged but deleted message');
  var staticNow = new Date(2000, 0, 1, 12, 0, 0).valueOf();
  testUniverse.do_timewarpNow(staticNow, 'Jan 1, 2000');
  T.setup('disable folder closing', function() {
    testAccount.imapAccount._TEST_doNotCloseFolder = true;
  });
  var testFolder = testAccount.do_createTestFolder(
    'test_stop_at_1990',
    { count: 1, age: { hours: 1 }, age_incr: { hours: 12 },
      // have the
      flags: ['Deleted'] });

  T.group('go to 1990 but no further!');
  const expectedZeroProbes = 40,
        expectsTo1990 = [];
  for (var iProbe = 0; iProbe < expectedZeroProbes; iProbe++) {
    expectsTo1990.push({ count: 0, full: 0, flags: 0, deleted: 0 });
  }

  testAccount.do_viewFolder('syncs', testFolder,
    expectsTo1990,
    { top: true, bottom: true, grow: false });

});

/**
 * If we keep refreshing, the time range should stay the same.  The compose
 * test, at least around certain times of day, however, ended up with each
 * refresh lopping off a day in a way that perceived the set reduction as
 * deletions and eventually ended up with no covered messages.  This caused
 * the refresh to screw up and try and sync from 0 milliseconds.
 */
TD.commonCase('repeated refresh is stable', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U', {}),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true });

  const fillSize = 3, totalCount = 4;
  testUniverse.do_adjustSyncValues({
    fillSize: fillSize,
  });

  var staticNow = new Date(2000, 0, 3, 23, 0, 0).valueOf();
  testUniverse.do_timewarpNow(staticNow, 'Jan 3rd, 2000');

  var testFolder = testAccount.do_createTestFolder(
    'test_stable_refresh',
    { count: totalCount, age: { days: 0 }, age_incr: { days: 1 } });

  T.group('open view, keep refreshing');
  var noChanges = {
    changes: [],
    deletions: []
  };
  var testView = testAccount.do_openFolderView(
    'refresher', testFolder,
    { count: fillSize, full: totalCount, flags: 0, deleted: 0 },
    { top: true, bottom: false, grow: false,
      // This is a deepening sync that covers everything, so we will have a
      // wider time span only on this one.
      startTS: 946339200000, endTS: 947030400000 },
    { syncedToDawnOfTime: true });
  var refreshSpanStart = 946771200000,
      refreshSpanEnd = 947030400000;
  testAccount.do_refreshFolderView(
    testView,
    { count: fillSize, full: 0, flags: fillSize, deleted: 0,
      startTS: refreshSpanStart, endTS: refreshSpanEnd },
    noChanges,
    { top: true, bottom: false, grow: false });
  testAccount.do_refreshFolderView(
    testView,
    { count: fillSize, full: 0, flags: fillSize, deleted: 0,
      startTS: refreshSpanStart, endTS: refreshSpanEnd },
    noChanges,
    { top: true, bottom: false, grow: false });
  testAccount.do_refreshFolderView(
    testView,
    { count: fillSize, full: 0, flags: fillSize, deleted: 0,
      startTS: refreshSpanStart, endTS: refreshSpanEnd },
    noChanges,
    { top: true, bottom: false, grow: false });

  T.group('cleanup');
});

function run_test() {
  runMyTests(20); // we do a lot of appending...
}

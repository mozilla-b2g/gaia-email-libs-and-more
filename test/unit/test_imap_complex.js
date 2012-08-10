/**
 * Test more complicated IMAP sync scenarios.  Currently, this means testing
 * the #1 and #2 heuristics of `sliceOpenFromNow` do the right thing under
 * "nothing has changed since last time", "minimal changes which we expected
 * have happened", and "oh no, lots of new messages showed up and our
 * heuristic has been off more than it can chew, I hope it does the right thing"
 * cases.
 **/

load('resources/loggest_test_framework.js');

var TD = $tc.defineTestsFor(
  { id: 'test_imap_complex' }, null, [$th_imap.TESTHELPER], ['app']);

// This gets clobbered into $imapslice by testhelper.js as a default.
// This really means 7.5 days
const INITIAL_SYNC_DAYS = 7,
      // This is the number of messages after which the sync logic will
      // declare victory and stop filling.
      INITIAL_FILL_SIZE = 15;

TD.DISABLED_commonCase('sliceOpenFromNow #1 and #2', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A', { universe: testUniverse }),
      eSync = T.lazyLogger('sync');

  /**
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
   * - Perform an open sync within the #1 time interval, verifying that it
   *   manifests as a #1 refresh.
   * - Perform an open sync outside the #1 time interval but within the #2
   *   time interval, verifying that it manifests as a known date range sync.
   * - Perform an open sync outside both time intervals, verifying that it
   *   manifests as our standard deepening probe.
   * - Warp time so that the messages fall under the "old" threshold, perform
   *   an open sync, verify that the #1 refresh strategy happens.
   *
   * "minimal changes we expected have happened"
   *
   * - Add a message, verify a #1 open refresh with the new message coming
   *   last.  This will be an 'old' message.
   * - Add another message, verify a #1 open refresh with one less message
   *   off the 'old' side and the new message coming last.
   * - Add another message, verify a #2 date sync with the new message coming
   *   first because it is newest and this was a sync.
   * - Add another message, verify a #2 date sync with the new message first
   *   and one less message on the 'old' side.
   * (No need to check that the deepening fallback happens.)
   *
   *
   * "oh no, lots of new messages"
   *
   * - Adjust overflow values, create a new folder with the same heuristics
   *   as before.
   * - Perform initial deepening sync.
   * - Add enough messages to trigger overflow conditions on the refresh and
   *   a subsequent naive date sync for expanding the range.
   * - Perform a #1-qualifying open, observe the initial set of messages
   *   followed by some of the overflow messages, and the retraction of the
   *   initial set of messages because our sync no longer reaches them.
   * - (We now have two islands of synchronized data.  The original fully
   *   synced interval, plus the new deepended interval, with a gap in between.
   *   This raises semantics issues for atBottom, but we define that the answer
   *   is we are not at the bottom and we will perform the extra sync required
   *   to link us up with our friends.  However, a distinct grow request is
   *   still required to trigger the network traffic.)
   * - Grow in the older direction, and verify that this appears to result in
   *   an overflow case that gets bisected down.
   *
   * - Create another new folder.
   * - Perform initial deepening sync.
   * - Add enough messages to trigger overflow conditions.
   * - Perform a #2 qualifying open, observe that we get some of the overflow
   *   messages and never see the older messages.
   *
   **/

  // Jan 28th, yo.  Intentionally avoiding dalight saving time
  // Static in the sense that we vary over the course of this defining function
  // rather than varying during dynamically during the test functions as they
  // run.
  var staticNow = Date.UTC(2012, 0, 28, 12, 0, 0);

  const HOUR_MILLIS = 60 * 60 * 1000, DAY_MILLIS = 24 * HOUR_MILLIS;
  const TSYNCI = 3;
  testUniverse.do_adjustSyncValues({
    fillSize: 3 * TSYNCI,
    days: TSYNCI,
    // never grow the sync interval!
    scaleFactor: 1,
    bisectThresh: 15,
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
  testUniverse.do_timewarpNow(staticNow, 'Jan 28th midnight UTC');
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

  T.group('no change: #1 refresh');
  staticNow += HOUR_MILLIS;
  testUniverse.do_timewarpNow(staticNow, '+1 hour');
  // XXX need to differentiate refresh and verify
  testAccount.do_viewFolder(
    '#1 refresh sync', c1Folder,
    { count: 9, full: 0, flags: 9, deleted: 0 },
    { top: true, bottom: true, grow: true });

  T.group('no change: #2 date range');
  staticNow += 3 * HOUR_MILLIS;
  testUniverse.do_timewarpNow(staticNow, '+3 hours');
  testAccount.do_viewFolder(
    '#2 date range sync', c1Folder,
    { count: 9, full: 0, flags: 9, deleted: 0 },
    { top: true, bottom: true, grow: true });

  T.group('no change: deepening fallback');
  // Jump time so that the messages are just under the old threshold.  They
  // are already 6 time intervals in the past, but we want them at 15, so
  // add 9 TSYNCI less 0.5 days.
  staticNow = createdAt +
              ((9 * TSYNCI) + 0.5) * DAY_MILLIS;
  testUniverse.do_timewarpNow(staticNow, '9 TSYNCI + 0.5 days out');
  testAccount.do_viewFolder(
    'syncs', c1Folder,
    [{ count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 0, full: 0, flags: 0, deleted: 0 },
     { count: 3, full: 0, flags: 3, deleted: 0 },
     { count: 3, full: 0, flags: 3, deleted: 0 },
     { count: 3, full: 0, flags: 3, deleted: 0 }],
    { top: true, bottom: true, grow: true });

  T.group('no change: #1 old thresh');
  staticNow = createdAt +
              ((9 * TSYNCI) + 1.5) * DAY_MILLIS;
  testUniverse.do_timewarpNow(staticNow, '9 TSYNCI + 1.5 days out');
  // XXX need to differentiate refresh and verify
  testAccount.do_viewFolder(
    '#1 refresh sync', c1Folder,
    { count: 9, full: 0, flags: 9, deleted: 0 },
    { top: true, bottom: true, grow: true });

  T.group('minimal changes: add, #1 (old) refresh');
  testAccount.do_addMessagesToFolder(
    c1Folder,
    { count: 1, age: { days: 1 } });
  staticNow += HOUR_MILLIS;
  testUniverse.do_timewarpNow(staticNow, '+1 hour');
  testAccount.do_viewFolder(
    '#1 refresh sync', c1Folder,
    { count: 10, full: 1, flags: 9, deleted: 0 },
    { top: true, bottom: true, grow: true });
  // (no longer qualifies as 'old' now)

  T.group('minimal changes: add, #2 date range');
  testAccount.do_addMessagesToFolder(
    c1Folder,
    { count: 1, age: { days: 1 } });
  staticNow += 3 * HOUR_MILLIS;
  testUniverse.do_timewarpNow(staticNow, '+3 hours');
  testAccount.do_viewFolder(
    '#2 date range sync', c1Folder,
    { count: 9, full: 1, flags: 9, deleted: 0 },
    { top: true, bottom: false, grow: false });

  T.group('minimal changes: add, #2 date range falloff');
  testAccount.do_addMessagesToFolder(
    c1Folder,
    { count: 1, age: { days: 1 } });
  staticNow += 3 * HOUR_MILLIS;
  testUniverse.do_timewarpNow(staticNow, '+3 hours');
  testAccount.do_viewFolder(
    '#2 date range sync', c1Folder,
    { count: 9, full: 1, flags: 9, deleted: 0 },
    { top: true, bottom: false, grow: false });


  T.group('lots of messages: setup for #1');
  // May 28th, intentionally staying far away from daylight savings time.
  staticNow = Date.UTC(2012, 4, 28, 0, 0, 0);
  testUniverse.do_timewarpNow(staticNow, 'May 28th midnight UTC');
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
    { top: true, bottom: true, grow: false });

  T.group('lots of messages:  #1 refresh open with overflow');
  testAccount.do_addMessagesToFolder(
    c2Folder,
    { count: 21, age: { days: 1.5 }, age_incr: { days: 1 } });
  staticNow += HOUR_MILLIS;
  testUniverse.do_timewarpNow(staticNow, '+1 hour');
  var f2View = testAccount.do_openFolderView(
    '#1 refresh sync', c2Folder,
    // the aborted refresh manifests as this...
    [{ count: 0, full: null, flags: null, deleted: null },
    // and then we get a normal deepening sync sequence
     { count: 3, full: 3, flags: 0, deleted: 0 },
     { count: 3, full: 3, flags: 0, deleted: 0 },
     { count: 3, full: 3, flags: 0, deleted: 0 }],
    { top: true, bottom: false, grow: false });

  T.group('free growth to previously synced message bounds');
  testAccount.do_growFolderView(
    f2View, 9, false, 9,
    // this will explode into a bisect covering 21 messages, it will guess 8
    // because Math.ceil(15 / 42 * 21 = 7.5) = 8.  This will trigger an
    // automated follow-on for another 8 days because it will use the same
    // time-window for the follow-on, 4 of which will already be known
    [{ count: 0, full: null, flags: null, deleted: null },
     { count: 8, full: 8, flags: 0, deleted: 0 }],
    { top: true, bottom: false, grow: false });
  testAccount.do_growFolderView(
    // do not request growth; we want to make sure we provide it for free since
    // we are saying atBottom is false and therefore so is grow.
    f2View, 10, false, 17,
     // this should properly only give us 10 messages, but the new messages
     // get interleaved and so we see them all at once.
     [{ count: 13, full: 4, flags: 9, deleted: 0 }],
    { top: true, bottom: true, grow: false });

  testAccount.do_closeFolderView(f2View);

  T.group('lots of messages: setup for #2');
  // May 28th, intentionally staying far away from daylight savings time.
  staticNow = Date.UTC(2012, 4, 30, 0, 0, 0);
  testUniverse.do_timewarpNow(staticNow, 'May 30th midnight UTC');
  createdAt = staticNow;

  var c3Folder = testAccount.do_createTestFolder(
    'test_complex_old3',
    // By choosing one more than the fill size(9), we ensure that the time range
    // won't stretch to the dawn of time and therefore that the interpolation
    // will not have to exercise its sanity check mode.
    { count: 10, age: { days: 6 * TSYNCI + 1 }, age_incr: { days: 1 } });
  testAccount.do_viewFolder(
    'syncs', c3Folder,
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

  T.group('lots of messages: #2 date range with overflow');
  testAccount.do_addMessagesToFolder(
    c3Folder,
    { count: 16, age: { days: 1.5 }, age_incr: { days: 1 } });
  staticNow += 3 * HOUR_MILLIS;
  testUniverse.do_timewarpNow(staticNow, '+3 hour');
  testAccount.do_viewFolder(
    '#2 date range', c3Folder,
    // this ends up as a bisection with 8 messages
    [{ count: 0, full: null, flags: null, deleted: null },
     { count: 8, full: 8, flags: 0, deleted: 0 },
     { count: 1, full: 8, flags: 0, deleted: 0 }],
    { top: true, bottom: false, grow: false });

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
 * and 3 messages per day.
 */
TD.commonCase('refresh does not break when db limit hit', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A', { universe: testUniverse }),
      eSync = T.lazyLogger('sync');

  // Jan 28th, yo.  Intentionally avoiding dalight saving time
  // Static in the sense that we vary over the course of this defining function
  // rather than varying during dynamically during the test functions as they
  // run.
  var staticNow = Date.UTC(2012, 0, 28, 12, 0, 0);

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
  testUniverse.do_timewarpNow(staticNow, 'Jan 28th midnight UTC');
  var createdAt = staticNow;
  var c1Folder = testAccount.do_createTestFolder(
    'test_complex_refresh',
    // we will sync 9, leave an extra 1 not to sync so grow is true.
    { count: 6, age: { hours: 12 }, age_incr: { hours: 1 } });
  testAccount.do_viewFolder(
    'syncs', c1Folder,
    [{ count: 6, full: 6, flags: 0, deleted: 0 }],
    { top: true, bottom: true, grow: false });

  T.group('no change: #1 refresh');
  staticNow += HOUR_MILLIS;
  testUniverse.do_timewarpNow(staticNow, '+1 hour');
  // XXX need to differentiate refresh and verify
  testAccount.do_viewFolder(
    '#1 refresh sync', c1Folder,
    { count: 6, full: 0, flags: 6, deleted: 0 },
    { top: true, bottom: true, grow: false });

  T.group('cleanup');
});


function run_test() {
  runMyTests(20); // we do a lot of appending...
}

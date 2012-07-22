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

TD.commonCase('sliceOpenFromNow #1 and #2', function(T) {
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
   *   last.
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
   * - Add enough messages to trigger overflow conditions on the refresh.
   * - Perform a #1-qualifying open, observe the initial set of messages
   *   followed by some of the overflow messages, and the retraction of the
   *   initial set of messages because our sync no longer reaches them.
   *
   * - Create another new folder.
   * - Perform initial deepening sync.
   * - Add enough messages to trigger overflow conditions.
   * - Perform a #2 qualifying open, observe that we get some of the overflow
   *   messages and never see the older messages.
   * 
   **/

  /**
   * Try and synchronize an empty folder.  Verify that our slice completes with
   * minimal legwork.
   */
  T.group('refresh, no changes');
  var emptyFolder = testAccount.do_createTestFolder(
    'test_empty_sync', { count: 0 });
  testAccount.do_viewFolder('syncs', emptyFolder,
                            { count: 0, full: 0, flags: 0, deleted: 0 },
                            { top: true, bottom: true, grow: false });
  testUniverse.do_pretendToBeOffline(true);
  testAccount.do_viewFolder('checks persisted data of', emptyFolder,
                            { count: 0, full: 0, flags: 0, deleted: 0 },
                            { top: true, bottom: true, grow: false });
  testUniverse.do_pretendToBeOffline(false);
  testAccount.do_viewFolder('resyncs', emptyFolder,
                            { count: 0, full: 0, flags: 0, deleted: 0 },
                            { top: true, bottom: true, grow: false });

  T.group('cleanup');
});

function run_test() {
  runMyTests(20); // we do a lot of appending...
}

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
  { id: 'test_activesync_general' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('folder sync', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testActiveSyncAccount', 'A',
                            { universe: testUniverse }),
      eSync = T.lazyLogger('sync');

  T.group('cleanup');
});

function run_test() {
  runMyTests(20); // we do a lot of appending...
}

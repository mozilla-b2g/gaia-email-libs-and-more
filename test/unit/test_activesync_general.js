/**
 * Test our ActiveSync sync logic under non-pathological conditions.  Currently,
 * this just tests that we can create an account successfully.  More tests
 * coming soon!
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

load('resources/loggest_test_framework.js');

var TD = $tc.defineTestsFor(
  { id: 'test_imap_just_auth' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('just auth', function(T) {
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A', { universe: testUniverse });
});

function run_test() {
  runMyTests(6);
}

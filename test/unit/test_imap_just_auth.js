load('resources/loggest_test_framework.js');

var TD = $tc.defineTestsFor(
  { id: 'blah' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('just auth', function(T) {
  var testAccount = T.actor('testImapAccount', 'A');
});

function run_test() {
  runMyTests(10); // we do a lot of appending...
}

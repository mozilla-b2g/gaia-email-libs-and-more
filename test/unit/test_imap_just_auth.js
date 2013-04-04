define(['rdcommon/testcontext', 'mailapi/testhelper', 'exports'],
       function($tc, $th_imap, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_imap_just_auth' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('just auth', function(T) {
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A', { universe: testUniverse });
});

}); // end define

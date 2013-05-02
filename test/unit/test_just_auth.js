define(['rdcommon/testcontext', './resources/th_main',
        './resources/th_activesync_server',
        'exports'],
       function($tc, $th_imap, $th_as_server, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_just_auth' }, null,
  [$th_imap.TESTHELPER, $th_as_server.TESTHELPER], ['app']);

TD.commonCase('just auth', function(T, RT) {
  var TEST_PARAMS = RT.envOptions;

  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse,
                              // for ActiveSync we want to support using something
                              // other than the default args, and we indeed only
                              // use them is we set realAccountNeeded, so do this.
                              realAccountNeeded: !TEST_PARAMS.defaultArgs });
});

}); // end define

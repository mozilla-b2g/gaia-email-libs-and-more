/**
 * ActiveSync-specific foldersync logic checks:
 * - Make sure the "Junk" folder is identified as having type 'junk'.
 */

define(['rdcommon/testcontext', './resources/th_main',
        'activesync/codepages', 'mailapi', 'exports'],
       function($tc, $th_main, $ascp, $mailapi, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_activesync_foldersync' }, null,
  [$th_main.TESTHELPER], ['app']);

TD.commonCase('junk folder type gets correctly inferred', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U'),
      // The fake IMAP server allows folderConfig to be passed as an option.
      // It's primarily needed to have an account that lacks specific folders
      // from the get-go.  Let's do that some day, but for now we'll just
      // dynamically create the folder.
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse }),
      eCheck = T.lazyLogger('check');

  var junkFolder = testAccount.do_createTestFolder('Junk', { count: 0 });

  T.group('check');
  T.check(eCheck, 'there better not be a muppet in here', function() {
    // do_createTestFolder already uses a ping to ensure the front-end state
    // reflects the folder.
    eCheck.expect_namedValueD('junk folder type', 'junk');
    eCheck.namedValueD('junk folder type',
                       junkFolder.mailFolder.type, junkFolder.mailFolder);
  });
});

});

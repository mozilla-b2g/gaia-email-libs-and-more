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

TD.commonCase('junk folder type gets correctly localized', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse }),
      eCheck = T.lazyLogger('check');

  var localizedName = 'Sir Junksters III';

  T.action('Set up MailAPI.useLocalizedStrings', function() {
    testUniverse.MailAPI.useLocalizedStrings({
      folderNames: {
        junk: localizedName
      }
    });
  });

  junkFolder = testAccount.do_createTestFolder('istenmeyen e-posta',
                                               { count: 0 });

  T.group('check');
  T.check(eCheck, 'Sir Junksters makes an appearance', function() {
    // do_createTestFolder already uses a ping to ensure the front-end state
    // reflects the folder.
    eCheck.expect_namedValue('localized junk name', localizedName);
    eCheck.namedValue('localized junk name', junkFolder.mailFolder.name);
  });

  T.group('cleanup');
});

});

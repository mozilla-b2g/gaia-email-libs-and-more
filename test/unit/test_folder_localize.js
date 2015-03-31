/**
 * ActiveSync-specific foldersync logic checks:
 * - Make sure the "Junk" folder is identified as having type 'junk'.
 */

define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');

return new LegacyGelamTest(
  'junk folder type gets correctly localized', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A',
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
    eCheck.expect('localized junk name', localizedName);
    eCheck.log('localized junk name', junkFolder.mailFolder.name);
  });

  T.group('cleanup');
});

});

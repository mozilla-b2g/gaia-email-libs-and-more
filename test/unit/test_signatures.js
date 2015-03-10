define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var $msggen = require('./resources/messageGenerator');

return new LegacyGelamTest('signatures', function(T, RT) {
  var testUniverse = T.actor('TestUniverse', 'U', {}),
      testAccount = T.actor('TestAccount', 'A',
                            { universe: testUniverse });

  var composer, eLazy = T.lazyLogger('check');

  T.action('Default Composition', eLazy, function() {
    eLazy.expect('compose setup completed');
    composer = MailAPI.beginMessageComposition(
      null, gAllFoldersSlice.getFirstFolderWithType('inbox'), null,
      eLazy.log.bind(eLazy, 'compose setup completed'));

  });

  T.action('Default Composition should have empty body',
    eLazy, function() {

    eLazy.expect('generated body',  '');
    eLazy.log('generated body', composer.body.text);
  });

  testAccount.do_modifyIdentity(0, { signature: "test 1", signatureEnabled: true});

  T.action('begin composition after modifyIdentity', eLazy, function() {
    eLazy.expect('compose setup completed');
    composer = MailAPI.beginMessageComposition(
      null, gAllFoldersSlice.getFirstFolderWithType('inbox'), null,
      eLazy.log.bind(eLazy, 'compose setup completed'));
  });

  T.action(testAccount, 'check composition after modifyIdentity', eLazy, function() {
    eLazy.expect('generated body 1',  '\n\n--\ntest 1');
    eLazy.log('generated body 1', composer.body.text);
  });

  testAccount.do_modifyIdentity(0, { signature: "test 2", signatureEnabled: false });

  T.action('begin composition after modifyIdentity 2', eLazy, function() {
    eLazy.expect('compose setup completed');
    composer = MailAPI.beginMessageComposition(
      null, gAllFoldersSlice.getFirstFolderWithType('inbox'), null,
      eLazy.log.bind(eLazy, 'compose setup completed'));
  });

  T.action(testAccount, 'check composition after modifyIdentity 2', eLazy, function() {
    eLazy.expect('generated body 2',  '');
    eLazy.log('generated body 2', composer.body.text);
  });


  testAccount.do_modifyIdentity(0, { signatureEnabled: true });

  T.action('begin composition after modifyIdentity 3', eLazy, function() {
    eLazy.expect('compose setup completed');
    composer = MailAPI.beginMessageComposition(
      null, gAllFoldersSlice.getFirstFolderWithType('inbox'), null,
      eLazy.log.bind(eLazy, 'compose setup completed'));
  });

  T.action(testAccount, 'check composition after modifyIdentity 3', eLazy, function() {
    eLazy.expect('generated body 3',  '\n\n--\ntest 2');
    eLazy.log('generated body 3', composer.body.text);
  });

});

});

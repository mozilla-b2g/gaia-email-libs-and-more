define(['rdcommon/testcontext', './resources/th_main',
        './resources/th_devicestorage', './resources/messageGenerator',
        'util', 'accountcommon', 'exports'],
       function($tc, $th_imap, $th_devicestorage, $msggen,
                $util, $accountcommon, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_signatures' }, null,
  [$th_imap.TESTHELPER, $th_devicestorage.TESTHELPER], ['app']);

TD.commonCase('signatures', function(T, RT) {
  var testUniverse = T.actor('testUniverse', 'U', {}),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse });

  var composer, eLazy = T.lazyLogger('check');

  T.action('Default Composition', eLazy, function() {
    eLazy.expect_event('compose setup completed');
    composer = MailAPI.beginMessageComposition(
      null, gAllFoldersSlice.getFirstFolderWithType('inbox'), null,
      eLazy.event.bind(eLazy, 'compose setup completed'));

  });

  T.action('Default Composition should have empty body',
    eLazy, function() {

    eLazy.expect_namedValue('generated body', '');
    eLazy.namedValue('generated body', composer.body.text);
  });

  testAccount.do_modifyIdentity(0, { signature: "test 1", signatureEnabled: true});

  T.action('begin composition after modifyIdentity', eLazy, function() {
    eLazy.expect_event('compose setup completed');
    composer = MailAPI.beginMessageComposition(
      null, gAllFoldersSlice.getFirstFolderWithType('inbox'), null,
      eLazy.event.bind(eLazy, 'compose setup completed'));
  });

  T.action(testAccount, 'check composition after modifyIdentity', eLazy, function() {
    eLazy.expect_namedValue('generated body 1', '\n\n--\ntest 1');
    eLazy.namedValue('generated body 1', composer.body.text);
  });

  testAccount.do_modifyIdentity(0, { signature: "test 2", signatureEnabled: false });

  T.action('begin composition after modifyIdentity 2', eLazy, function() {
    eLazy.expect_event('compose setup completed');
    composer = MailAPI.beginMessageComposition(
      null, gAllFoldersSlice.getFirstFolderWithType('inbox'), null,
      eLazy.event.bind(eLazy, 'compose setup completed'));
  });

  T.action(testAccount, 'check composition after modifyIdentity 2', eLazy, function() {
    eLazy.expect_namedValue('generated body 2', '');
    eLazy.namedValue('generated body 2', composer.body.text);
  });


  testAccount.do_modifyIdentity(0, { signatureEnabled: true });

  T.action('begin composition after modifyIdentity 3', eLazy, function() {
    eLazy.expect_event('compose setup completed');
    composer = MailAPI.beginMessageComposition(
      null, gAllFoldersSlice.getFirstFolderWithType('inbox'), null,
      eLazy.event.bind(eLazy, 'compose setup completed'));
  });

  T.action(testAccount, 'check composition after modifyIdentity 3', eLazy, function() {
    eLazy.expect_namedValue('generated body 3', '\n\n--\ntest 2');
    eLazy.namedValue('generated body 3', composer.body.text);
  });

});

});

/**
 * Test our ActiveSync sync logic under non-pathological conditions.  Currently,
 * this just tests that we can create an account successfully.  More tests
 * coming soon!
 **/

define(['rdcommon/testcontext', './resources/th_main',
        'exports'],
       function($tc, $th_main, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_activesync_errors' }, null,
  [$th_main.TESTHELPER], ['app']);

TD.commonCase('reports bad password', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse }),
      eCheck = T.lazyLogger('check');

  T.group('change to the wrong password');
  T.action('change pw', eCheck, function() {
    eCheck.expect_event('roundtrip');
    var acct = testUniverse.allAccountsSlice.items[0];
    acct.modifyAccount({ password: 'NOTTHERIGHTPASSWORD' });
    // we don't need to wait for correctness; just to keep any errors in the
    // right test step rather than letting them smear into the next one.
    testUniverse.MailAPI.ping(function() {
      eCheck.event('roundtrip');
    });
  });

  T.group('use bad password');
  T.action('create connection, should fail, generate MailAPI event', eCheck,
           function() {
    eCheck.expect_namedValue('accountCheck:err', true);
    eCheck.expect_namedValue('account:enabled', false);
    eCheck.expect_namedValue('account:problems', ['bad-user-or-pass']);
    eCheck.expect_event('badlogin');

    testUniverse.MailAPI.onbadlogin = function(acct) {
      eCheck.event('badlogin');
    };

    var errAndCallback = function(err) {
      eCheck.namedValue('accountCheck:err', !!err);
      eCheck.namedValue('account:enabled',
                        testAccount.account.enabled);
      eCheck.namedValue('account:problems',
                        testAccount.account.problems);
    };
    testAccount.account.conn.disconnect();
    testAccount.account.conn = null;
    testAccount.account.withConnection(errAndCallback, errAndCallback);

  }).timeoutMS = 5000;

  T.action('put good password back', eCheck, function() {
    eCheck.expect_event('roundtrip');
    var acct = testUniverse.allAccountsSlice.items[0];
    acct.modifyAccount({ password: TEST_PARAMS.password });
    // we don't need to wait for correctness; just to keep any errors in the
    // right test step rather than letting them smear into the next one.
    testUniverse.MailAPI.ping(function() {
      eCheck.event('roundtrip');
    });
  });

  T.action('healthy connect!', eCheck, testAccount, function() {

    eCheck.expect_namedValue('accountCheck:err', false);
    eCheck.expect_namedValue('account:enabled', true);
    eCheck.expect_namedValue('account:problems', []);

    var errAndCallback = function(err) {
      eCheck.namedValue('accountCheck:err', !!err);
      testUniverse.universe.clearAccountProblems(testAccount.account);
      eCheck.namedValue('account:enabled',
                        testAccount.account.enabled);
      eCheck.namedValue('account:problems',
                        testAccount.account.problems);
    };

    testAccount.account.conn.disconnect();
    testAccount.account.conn = null;
    testAccount.account.withConnection(errAndCallback, errAndCallback);
  }).timeoutMS = 5000;
  T.group('cleanup');
});

}); // end define

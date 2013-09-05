/**
 * Test whether an account responds properly to an invalid password,
 * both for ActiveSync and IMAP accounts.
 **/

define(['rdcommon/testcontext', './resources/th_main',
        'exports'],
       function($tc, $th_main, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_account_bad_password_error' }, null,
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

  // Tests to see that a valid connection can be made to the account.
  function checkAccount(cb) {
    if (testAccount.type === 'imap') {
      testAccount.folderAccount.checkAccount(cb);
    } else if (testAccount.type === 'activesync') {
      testAccount.folderAccount.conn.disconnect();
      testAccount.folderAccount.conn = null;
      testAccount.folderAccount.withConnection(function(err) {
        cb(err);
      }, function() {
        cb();
      });
    }
  }

  T.group('use bad password');
  T.action('create connection, should fail, generate MailAPI event',
           eCheck, testAccount.eBackoff, function() {
    eCheck.expect_namedValue('accountCheck:err', true);
    eCheck.expect_namedValue('account:enabled', false);
    eCheck.expect_namedValue('account:problems', ['bad-user-or-pass']);
    eCheck.expect_event('badlogin');

    // only IMAP accounts have eBackoff
    if (testAccount.type === 'imap') {
      testAccount.eBackoff.expect_connectFailure(true);
      testAccount.eBackoff.expect_state('broken');
    }

    testUniverse.MailAPI.onbadlogin = function(acct) {
      eCheck.event('badlogin');
    };

    checkAccount(function(err) {
      eCheck.namedValue('accountCheck:err', !!err);
      eCheck.namedValue('account:enabled',
                        testAccount.folderAccount.enabled);
      eCheck.namedValue('account:problems',
                        (testAccount.compositeAccount ||
                         testAccount.folderAccount).problems);
    });

  }).timeoutMS = 5000;

  T.group('use good password');
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

  T.action('healthy connect!', eCheck, testAccount,
           testAccount.eBackoff,
           testAccount.eImapAccount, function() {
    if (testAccount.type === 'imap') {
      testAccount.eBackoff.expect_state('healthy');
    }
    eCheck.expect_namedValue('accountCheck:err', false);
    eCheck.expect_namedValue('account:enabled', true);

    checkAccount(function(err) {
      eCheck.namedValue('accountCheck:err', !!err);
      testUniverse.universe.clearAccountProblems(testAccount.folderAccount);
      eCheck.namedValue('account:enabled',
                        testAccount.folderAccount.enabled);
    });
  }).timeoutMS = 5000;
  T.group('cleanup');
});

}); // end define

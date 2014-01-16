/**
 * Test whether an account responds properly to an invalid password,
 * both for ActiveSync and IMAP accounts.
 *
 * ActiveSync does not use persistent connections, but it has a notion of being
 * 'connected' in terms of having established the right server endpoint to talk
 * to and having retrieved the OPTIONS.  Accordingly, we both test
 * authentication failure on initial connect (OPTIONS) stage, as well as when we
 * are already connected.
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

  function changeClientPassword(password, desc) {
    T.action('change the client password to', password, '(' + desc + ')',
             eCheck, function() {
      eCheck.expect_event('roundtrip');
      var acct = testUniverse.allAccountsSlice.items[0];
      acct.modifyAccount({ password: password });
      // we don't need to wait for correctness; just to keep any errors in the
      // right test step rather than letting them smear into the next one.
      testUniverse.MailAPI.ping(function() {
        eCheck.event('roundtrip');
      });
    });
  }

  function changeServerPassword(password, desc) {
    T.action('change the server password to', password, '(' + desc + ')',
             eCheck, function() {

      // this executes synchronously; no expectations required
      testAccount.testServer.changeCredentials(
        { password: password });
    });
  }

  /**
   * Set whether or not the server will drop the connection after
   * failed authentication.
   */
  function setDropOnAuthFailure(dropOnAuthFailure) {
    T.action('set dropOnAuthFailure = ', dropOnAuthFailure.toString(),
             eCheck, function() {
      testAccount.testServer.setDropOnAuthFailure(dropOnAuthFailure);
    });
  }

  T.group('use bad password on initial connect');
  changeServerPassword('newPassword1', 'mismatch');
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

    testAccount.folderAccount.checkAccount(function(err) {
      eCheck.namedValue('accountCheck:err', !!err);
      eCheck.namedValue('account:enabled',
                        testAccount.folderAccount.enabled);
      eCheck.namedValue('account:problems',
                        (testAccount.compositeAccount ||
                         testAccount.folderAccount).problems);
    });

  }).timeoutMS = 5000;

  if (testAccount.type === 'pop3') {
    T.group('pop3 handles connection drop on auth failure');
    // clear problems from the previous failure so that we still
    // receive proper onbadlogin events below
    T.action('clear account problems', eCheck, function() {
      var acct = testUniverse.allAccountsSlice.items[0];
      acct.clearProblems();
    });

    setDropOnAuthFailure(true);
    changeServerPassword('newPassword1', 'mismatch');
    T.action('create connection, should fail, generate MailAPI event',
             eCheck, testAccount.eBackoff, function() {
      eCheck.expect_namedValue('accountCheck:err', true);
      eCheck.expect_namedValue('account:enabled', false);
      eCheck.expect_namedValue('account:problems',
        ['bad-user-or-pass', 'connection']);
      eCheck.expect_event('badlogin');

      testUniverse.MailAPI.onbadlogin = function(acct) {
        eCheck.event('badlogin');
      };

      testAccount.folderAccount.checkAccount(function(err) {
        eCheck.namedValue('accountCheck:err', !!err);
        eCheck.namedValue('account:enabled',
                          testAccount.folderAccount.enabled);
        eCheck.namedValue('account:problems',
                          (testAccount.compositeAccount ||
                           testAccount.folderAccount).problems);
      });

    }).timeoutMS = 5000;

    // reset it back to normal
    setDropOnAuthFailure(false);
  }

  T.group('use good password on initial connect');
  changeClientPassword('newPassword1', 'match');

  T.action('healthy connect!', eCheck, testAccount,
           testAccount.eBackoff,
           testAccount.eImapAccount, function() {
    if (testAccount.type === 'imap') {
      testAccount.eBackoff.expect_state('healthy');
    }
    eCheck.expect_namedValue('accountCheck:err', false);
    eCheck.expect_namedValue('account:enabled', true);

    testAccount.folderAccount.checkAccount(function(err) {
      eCheck.namedValue('accountCheck:err', !!err);
      var acct = testUniverse.allAccountsSlice.items[0];
      acct.clearProblems(function() {
        eCheck.namedValue('account:enabled',
                          testAccount.folderAccount.enabled);

      });
    });
  }).timeoutMS = 5000;

  // ActiveSync only; as discussed in the file block comment, make sure that if
  // the connection is already 'established' (OPTIONS run) that we still error.
  // The initial fix did not detect this.)
  if (testAccount.type === 'activesync') {

    T.group('sync a folder with good password');

    var testFolder = testAccount.do_createTestFolder(
      'test_bad_password_sync', { count: 1 });

    var folderView = testAccount.do_openFolderView(
      'syncs', testFolder,
      { count: 1, full: 1, flags: 0, changed: 0, deleted: 0,
        filterType: 'none' },
      { top: true, bottom: true, grow: false },
      { syncedToDawnOfTime: true });

    T.group('resync folder with bad password');
    changeServerPassword('newPassword2', 'mismatch');

    // Try and sync; we should fail and badlogin should be generated.
    // (onbadlogin is still set to generate badlogin events)
    testAccount.do_refreshFolderView(
      folderView,
      { count: 1, full: null, flags: null, changed: null, deleted: null },
      { changes: [], deletions: [] },
      { top: true, bottom: true, grow: false },
      {
        failure: true,
        expectFunc: function() {
          RT.reportActiveActorThisStep(eCheck);
          eCheck.expect_event('badlogin');
        }
      });
  }
  T.group('cleanup');
});

}); // end define

/**
 * Test IMAP common/high-level error-handling logic and error cases that aren't
 * tested by more specific tests.
 *
 * There are two broad classes of errors we test:
 * 1) Connection losses due to network glitches, etc.
 * 2) Logic errors on our part, be they our code doing something that throws an
 *    exception, or our code triggering a server error that we don't know how to
 *    handle.
 *
 * We handle testing backoff logic by replacing the use of setTimeout by a
 * helper function.
 *
 * We test the following here:
 * - Sync connect failure: Can't talk to the server at all.
 * - Sync login failure: The server does not like our credentials.
 *
 * We test these things elsewhere:
 * - IMAP prober issues: test_imap_prober.js
 *
 * We want tests for the following (somewhere):
 * - Sync connection loss on SELECT. (This is during the opening of the folder
 *    connection and therefore strictly before actual synchronization logic is
 *    under way.)
 * - Sync connection loss on UID SEARCH. (This is during the _reliaSearch call,
 *    which theoretically is restartable without any loss of sync logic state.)
 * - Sync connection loss on UID FETCH. (This is within the sync process itself,
 *    which theoretically is restartable if the IMAP connection maintains its
 *    state and re-establishes.)
 **/

load('resources/loggest_test_framework.js');
// Use the faulty socket implementation.
load('resources/fault_injecting_socket.js');

var $_errbackoff = require('mailapi/errbackoff');

var TD = $tc.defineTestsFor(
  { id: 'test_imap_errors' }, null, [$th_imap.TESTHELPER], ['app']);


function thunkErrbackoffTimer(lazyLogger) {
  var backlog = [];
  $_errbackoff.TEST_useTimeoutFunc(function(func, delay) {
    backlog.push(func);
    lazyLogger.namedValue('errbackoff:schedule', delay);
  });
  return function releaser() {
    for (var i = 0; i < backlog.length; i++) {
      backlog[i]();
    }
    backlog = [];
  };
}

function zeroTimeoutErrbackoffTimer(lazyLogger) {
  $_errbackoff.TEST_useTimeoutFunc(function(func, delay) {
    lazyLogger.namedValue('errbackoff:schedule', delay);
    window.setZeroTimeout(func);
  });
}

/**
 * Attempt to connect to a server with immediate failures each time (that we
 * have already established an account for).  Verify that we do the backoff
 * logic and eventually give up, waiting for a manual retrigger.  Then retrigger
 * and make sure we don't retry since we're already in a known degraded state.
 * Then reconnect in a healthy state, verifying that a job we scheduled earlier
 * finally gets the connection.  Let the job complete correctly (error cases
 * when jobs hold the connection are a different test case).  Then close
 * all connections, and try to connect again with errors, making sure we do
 * the retry connects again since we had returned to a healthy state.
 */
TD.commonCase('general reconnect logic', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: false }),
      eCheck = T.lazyLogger('check');

  var errbackReleaser = thunkErrbackoffTimer(eCheck);

  // (The account is now setup, so we can start meddling.  It does have an
  // outstanding connection which we will need to kill.)

  // we would ideally extract this in case we are running against other servers
  var testHost = 'localhost', testPort = 143;

  T.action('kill the existing connection of', testAccount.eImapAccount,
           function() {
    FawltySocketFactory.getMostRecentLiveSocket().doNow('instant-close');
    testAccount._unusedConnections = 0;
    testAccount.eImapAccount.expect_deadConnection();
  });

  T.group('retries, give-up');
  T.action('initiate connection, fail', eCheck, testAccount.eBackoff,
           function() {
    // Queue up all the failures ahead of time: first connect, then 3 retries
    // before giving up.
    FawltySocketFactory.precommand(testHost, testPort, 'port-not-listening');
    FawltySocketFactory.precommand(testHost, testPort, 'port-not-listening');
    FawltySocketFactory.precommand(testHost, testPort, 'port-not-listening');
    FawltySocketFactory.precommand(testHost, testPort, 'port-not-listening');
    // Then 1 more failure on the next attempt.
    FawltySocketFactory.precommand(testHost, testPort, 'port-not-listening');

    testAccount.eBackoff.expect_connectFailure(false);
    eCheck.expect_namedValue('accountCheck:err', true);
    eCheck.expect_namedValue('errbackoff:schedule', 0);
    // Use checkAccount to trigger the connection creation, which helps verify
    // that checkConnection provides immediate feedback rather than getting
    // confused and trying to wait for error handling to kick in.
    testAccount.imapAccount.checkAccount(function(err) {
      eCheck.namedValue('accountCheck:err', !!err);
    });

    // let's also demand the connection so we can verify that this does not
    // try to create an additional connection as well as have something that
    // gets fulfilled when we finally have a real connection.

    testAccount.imapAccount.__folderDemandsConnection(null, 'test',
      function(conn) {
        eCheck.event('connection demand fulfilled');
        testAccount.imapAccount.__folderDoneWithConnection(conn, false, false);
      },
      function() {
        eCheck.event('conn deathback!');
      });

  });
  T.action('pretend timeout fired #1', eCheck, testAccount.eBackoff,
           function() {
    testAccount.eBackoff.expect_connectFailure(false);
    testAccount.eBackoff.expect_state('unreachable');
    eCheck.expect_namedValue('errbackoff:schedule', 800);
    errbackReleaser();
  });
  T.action('pretend timeout fired #2', eCheck, testAccount.eBackoff,
           function() {
    testAccount.eBackoff.expect_connectFailure(false);
    eCheck.expect_namedValue('errbackoff:schedule', 4500);
    errbackReleaser();
  });
  T.action('pretend timeout fired #3', eCheck, testAccount.eBackoff,
           function() {
    testAccount.eBackoff.expect_connectFailure(false);
    errbackReleaser();
  });

  T.group('next retry only tries once');
  T.action('initiate connection, fail, no retry', eCheck, testAccount.eBackoff,
           function() {
    testAccount.eBackoff.expect_connectFailure(false);
    eCheck.expect_namedValue('accountCheck:err', true);
    // Use checkAccount to trigger the connection creation, which helps verify
    // that checkConnection provides immediate feedback rather than getting
    // confused and trying to wait for error handling to kick in.
    testAccount.imapAccount.checkAccount(function(err) {
      eCheck.namedValue('accountCheck:err', !!err);
    });
  });
  T.check('no precommands left', function() {
    FawltySocketFactory.assertNoPrecommands();
  });

  T.group('recover');
  T.action('healthy connect!', eCheck, testAccount.eBackoff,
           testAccount.eImapAccount,
           function() {
    // the connection demand we placed above will now reuse and release the
    // conn.
    eCheck.expect_event('connection demand fulfilled');
    eCheck.expect_namedValue('accountCheck:err', false);
    testAccount.eBackoff.expect_state('healthy');
    testAccount.eImapAccount.expect_createConnection();
    testAccount.eImapAccount.expect_reuseConnection();
    testAccount.eImapAccount.expect_releaseConnection();
    testAccount.imapAccount.checkAccount(function(err) {
      eCheck.namedValue('accountCheck:err', !!err);
    });
  });
  T.action('close unused connections of', testAccount.eImapAccount,
           function() {
    testAccount.eImapAccount.expect_deadConnection();
    testAccount.imapAccount.closeUnusedConnections();
  });

  T.group('fail to connect, full retries again');
  T.action('initiate connection, fail', eCheck, testAccount.eBackoff,
           function() {
    // Queue up all the failures ahead of time: first connect, then 3 retries
    // before giving up.
    FawltySocketFactory.precommand(testHost, testPort, 'port-not-listening');
    FawltySocketFactory.precommand(testHost, testPort, 'port-not-listening');
    FawltySocketFactory.precommand(testHost, testPort, 'port-not-listening');
    FawltySocketFactory.precommand(testHost, testPort, 'port-not-listening');

    testAccount.eBackoff.expect_connectFailure(false);
    eCheck.expect_namedValue('accountCheck:err', true);
    eCheck.expect_namedValue('errbackoff:schedule', 0);
    testAccount.imapAccount.checkAccount(function(err) {
      eCheck.namedValue('accountCheck:err', !!err);
    });
  });
  T.action('pretend timeout fired #1', eCheck, testAccount.eBackoff,
           function() {
    testAccount.eBackoff.expect_connectFailure(false);
    testAccount.eBackoff.expect_state('unreachable');
    eCheck.expect_namedValue('errbackoff:schedule', 800);
    errbackReleaser();
  });
  T.action('pretend timeout fired #2', eCheck, testAccount.eBackoff,
           function() {
    testAccount.eBackoff.expect_connectFailure(false);
    eCheck.expect_namedValue('errbackoff:schedule', 4500);
    errbackReleaser();
  });
  T.action('pretend timeout fired #3', eCheck, testAccount.eBackoff,
           function() {
    testAccount.eBackoff.expect_connectFailure(false);
    errbackReleaser();
  });

});

/**
 * Change our password to the wrong password, then try to open a new connection
 * and make sure we notice and the bad password event fires.
 *
 * We don't use failure injection for this test, but
 * XXX we should strongly consider just using failure injection to fake the
 * password failure since the server forces a delay that is annoying (if
 * realistic.)
 */
TD.commonCase('bad password login failure', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eCheck = T.lazyLogger('check');

  // we would ideally extract this in case we are running against other servers
  var testHost = 'localhost', testPort = 143;

  // NB: because we restored the account, we do not have a pre-existing
  // connection, so there is no connection to kill.

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
           testAccount.eBackoff, function() {
    // XXX uh, this bit was written speculatively to make things go faster,
    // but FawltySocketFactory doesn't support it yet.  May just want to wait
    // and switch to IMAP fake-server instead.
    /*
    FawltySocketFactory.precommand(
      testHost, testPort, null,
      {
        match: 'LOGIN',
        actions: [
          'detach',
          {
            cmd: 'fake-receive',
            data: 'A2 NO [AUTHENTICATIONFAILED] Authentication failed.\n',
          }
        ]
      });
    */

    testAccount.eBackoff.expect_connectFailure(true);
    eCheck.expect_namedValue('accountCheck:err', true);
    eCheck.expect_namedValue('account:enabled', false);
    eCheck.expect_namedValue('account:problems', ['bad-user-or-pass']);
    eCheck.expect_event('badlogin');
    // no reconnect should be attempted, but we should transition directly to
    // broken.
    testAccount.eBackoff.expect_state('broken');

    testUniverse.MailAPI.onbadlogin = function(acct) {
      eCheck.event('badlogin');
    };
    // Use checkAccount to trigger the connection creation, which helps verify
    // that checkConnection provides immediate feedback rather than getting
    // confused and trying to wait for error handling to kick in.
    testAccount.imapAccount.checkAccount(function(err) {
      eCheck.namedValue('accountCheck:err', !!err);
      eCheck.namedValue('account:enabled',
                        testAccount.compositeAccount.enabled);
      eCheck.namedValue('account:problems',
                        testAccount.compositeAccount.problems);
    });
    // we want to test resumption of ops too...
    testAccount.imapAccount.__folderDemandsConnection(null, 'test',
      function(conn) {
        eCheck.event('connection demand fulfilled');
        testAccount.imapAccount.__folderDoneWithConnection(conn, false, false);
      },
      function() {
        eCheck.event('conn deathback!');
      });
  }).timeoutMS = 5000; // servers like explicit delays...

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
  T.action('healthy connect!', eCheck, testAccount.eBackoff,
           testAccount.eImapAccount,
           function() {
    eCheck.expect_event('connection demand fulfilled');
    eCheck.expect_namedValue('accountCheck:err', false);
    eCheck.expect_namedValue('account:enabled', true);
    testAccount.eBackoff.expect_state('healthy');
    testAccount.eImapAccount.expect_createConnection();
    testAccount.eImapAccount.expect_reuseConnection();
    testAccount.eImapAccount.expect_releaseConnection();
    testAccount.imapAccount.checkAccount(function(err) {
      eCheck.namedValue('accountCheck:err', !!err);
      // trigger the clear; in this case we are approximating the behaviour
      // of MailAPI's MailAccount.clearProblems() on the bridge side rather
      // than directly using it, but it's very simple, so this is fine.
      testUniverse.universe.clearAccountProblems(testAccount.compositeAccount);
      eCheck.namedValue('account:enabled',
                        testAccount.compositeAccount.enabled);
    });
  }).timeoutMS = 5000;
});

/**
 * Sometimes a server doesn't want to let us into a folder.  For example,
 * Yahoo will do this.
 *
 * THIS TEST IS NOT COMPLETE
 */
TD.DISABLED_commonCase('IMAP server forbids SELECT', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('sync');

});

/**
 * Verify that we handle connection loss when entering a folder.  Do this by
 * opening a slice to display the contents of a folder and verifying that the
 * slice still opens after the connection loss.
 *
 * THIS TEST IS NOT COMPLETE
 */
TD.DISABLED_commonCase('IMAP connection loss on SELECT', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('sync');

  // we would ideally extract this in case we are running against other servers
  var testHost = 'localhost', testPort = 143;

  var testFolder = testAccount.do_createTestFolder(
    'test_err_select_loss',
    { count: 4, age: { days: 0 }, age_incr: { days: 1 } });

  T.group('SELECT time');
  T.action('queue up SELECT to result in connection loss', function() {
    FawltySocketFactory.precommand(
      testHost, testPort, null,
      {
        match: 'SELECT',
        actions: [
          'instant-close',
        ]
      });
  });
  testAccount.do_viewFolder('syncs', testFolder,
                            { count: 4, full: 4, flags: 0, deleted: 0 },
                            { top: true, bottom: true, grow: false });
});

/**
 * Verify that a folder still synchronizes correctly even though we lose the
 * connection in the middle of the synchronization.
 *
 * THIS TEST IS NOT COMPLETE
 */
TD.DISABLED_commonCase('IMAP connection loss on FETCH', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('sync');

});

/**
 * Synchronize a folder so growth is possible, have the connection drop, then
 * issue a growth request and make sure we sync the additional messages as
 * expected.
 *
 * THIS TEST IS NOT COMPLETE
 */
TD.DISABLED_commonCase('Incremental sync after connection loss', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('sync');

});

function run_test() {
  runMyTests(15);
}

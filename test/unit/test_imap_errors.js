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
 * - connect failures with reconnect logic (connection level)
 * - error handlers properly tracked on reused connections (sync level)
 * - bad password (connection/account level)
 * - connection loss during a sync on each of our SELECT, SEARCH and FETCH
 *   requests
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

define(['rdcommon/testcontext', './resources/th_main',
        './resources/fault_injecting_socket', 'errbackoff', 'exports'],
       function($tc, $th_imap, $fawlty, $errbackoff, exports) {
var FawltySocketFactory = $fawlty.FawltySocketFactory;

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_imap_errors' }, null, [$th_imap.TESTHELPER], ['app']);


function doNotThunkErrbackoffTimer() {
  $errbackoff.TEST_useTimeoutFunc(window.setTimeout.bind(window));
}

function thunkErrbackoffTimer(lazyLogger) {
  var backlog = [];
  $errbackoff.TEST_useTimeoutFunc(function(func, delay) {
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
  $errbackoff.TEST_useTimeoutFunc(function(func, delay) {
    if (lazyLogger)
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
    FawltySocketFactory.precommand(
      testAccount.imapHost, testAccount.imapPort, 'port-not-listening');
    FawltySocketFactory.precommand(
      testAccount.imapHost, testAccount.imapPort, 'port-not-listening');
    FawltySocketFactory.precommand(
      testAccount.imapHost, testAccount.imapPort, 'port-not-listening');
    FawltySocketFactory.precommand(
      testAccount.imapHost, testAccount.imapPort, 'port-not-listening');
    // Then 1 more failure on the next attempt.
    FawltySocketFactory.precommand(
      testAccount.imapHost, testAccount.imapPort, 'port-not-listening');

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
    testAccount.eImapAccount.expect_checkAccount_begin(null);
    testAccount.eImapAccount.expect_createConnection();
    testAccount.eImapAccount.expect_reuseConnection();
    testAccount.eImapAccount.expect_releaseConnection();
    testAccount.eImapAccount.expect_checkAccount_end(null);
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
    FawltySocketFactory.precommand(
      testAccount.imapHost, testAccount.imapPort, 'port-not-listening');
    FawltySocketFactory.precommand(
      testAccount.imapHost, testAccount.imapPort, 'port-not-listening');
    FawltySocketFactory.precommand(
      testAccount.imapHost, testAccount.imapPort, 'port-not-listening');
    FawltySocketFactory.precommand(
      testAccount.imapHost, testAccount.imapPort, 'port-not-listening');

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

  T.group('cleanup');
  T.cleanup('kill sockets', function() {
    FawltySocketFactory.reset();
  });
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
 * Verify that we handle connection loss during sync by generating a syncfailed
 * notification.  Ideally we would retry opening the folder at least once, but
 * right now this just codifies our current behaviour to avoid regressions.
 *
 * XXX Expand this test to cover our existing-header update FETCH.  Right now
 * this only checks the new-header update FETCH.
 */
TD.commonCase('sync generates syncfailed on SELECT/SEARCH/FETCH failures',
              function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('sync');

  // we already tested the backoff logic up above; don't need it here.
  zeroTimeoutErrbackoffTimer(eSync);

  var testFolder = testAccount.do_createTestFolder(
    'test_err_sync_loss',
    { count: 4, age: { days: 0 }, age_incr: { days: 1 } });
  // Because initial syncs enter the folder before we begin the sync process in
  // order to get a count of the messages in the folder, we need to initiate a
  // sync here so the SELECT test below is not an initial sync.
  testAccount.do_viewFolder(
    'syncs', testFolder,
    { count: 4, full: 4, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, growUp: false },
    { syncedToDawnOfTime: true });

  T.group('SELECT time');
  T.action('queue up SELECT to result in connection loss', function() {
    // the connection is already established because we created a folder.
    FawltySocketFactory.getMostRecentLiveSocket().doOnSendText([
      {
        match: /SELECT/,
        actions: ['instant-close'],
      }
    ]);
  });
  testAccount.do_viewFolder(
    'syncs', testFolder,
    { count: 4, full: 0, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, growUp: false },
    { failure: 'deadconn' });

  T.group('SEARCH time');
  T.action('queue up SEARCH to result in connection loss', function() {
    FawltySocketFactory.precommand(
      testAccount.imapHost, testAccount.imapPort, null,
      [
        {
          match: /SEARCH/,
          actions: ['instant-close'],
        }
      ]);
  });
  testAccount.do_viewFolder(
    'syncs', testFolder,
    { count: 4, full: 0, flags: 4, deleted: 0 },
    { top: true, bottom: true, grow: false, growUp: false },
    { failure: false,
      expectFunc: function() {
        RT.reportActiveActorThisStep(testAccount.eImapAccount);
        testAccount.eImapAccount.expect_deadConnection();
        testAccount.eImapAccount.expect_createConnection();
        testAccount.eImapAccount.expect_reuseConnection();
      }
    });

  T.group('FETCH time');

  testAccount.do_viewFolder(
    'syncs', testFolder,
    { count: 4, full: 0, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, growUp: false },
    { failure: 'deadconn', expectFunc: function() {
      FawltySocketFactory.getMostRecentLiveSocket().doOnSendText(
        [{ match: /FETCH/, actions: ['instant-close'] }]);
    }});

  T.group('cleanup');
});

/**
 * Generate a connection loss during a "downloadBodies" job; the job should
 * experience an aborted-retry error, then get retried and the bodies should
 * still show up.
 */
TD.commonCase('Connection loss during bulk body fetches', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eCheck = T.lazyLogger('check');

  // we already tested the backoff logic up above; don't need it here.
  zeroTimeoutErrbackoffTimer();

  var testFolder = testAccount.do_createTestFolder(
    'test_err_downloadBodies',
    { count: 4, age: { days: 0 }, age_incr: { days: 1 } });

  var folderView = testAccount.do_openFolderView(
    'sync', testFolder,
    null,
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  T.action('download bodies: fail, check, succeed', function() {
    // the first time will fail and the (already owned/used) connection will die
    testAccount.expect_runOp(
      'downloadBodies',
      // no save because nothing will be accomplished and we optimize that case
      { local: false, server: true, save: false,
        release: 'deadconn', error: 'aborted-retry' });

    // we will have to run a check!
    testAccount.expect_runOp(
      'downloadBodies',
      { mode: 'check', local: false, server: true, save: false });

    // the second time will get a new connection and succeed
    testAccount.expect_runOp(
      'downloadBodies',
      { local: false, server: true, conn: true, release: false, save: 'server' });

    // rig the connection to explode on our fetch.
    FawltySocketFactory.getMostRecentLiveSocket().doOnSendText([
      {
        match: /FETCH/,
        actions: ['instant-close'],
      }
    ]);

    // trigger the download
    folderView.slice.maybeRequestBodies(0, folderView.slice.items.length - 1);
  });
  // If we have snippets now, then the above must have happened!
  T.check(eCheck, 'check download success via the existence of snippets', function() {
    eCheck.expect_namedValue('snippets present', folderView.slice.items.length);
    testUniverse.MailAPI.ping(function() {
      var snippetsPresent = 0;
      for (var i = 0; i < folderView.slice.items.length; i++) {
        var header = folderView.slice.items[i];
        // Technically '' would be a snippet too, but all of these messages
        // should have proper snippets
        if (header.snippet)
          snippetsPresent++;
      }
      eCheck.namedValue('snippets present', snippetsPresent);
    });
  });

  T.group('cleanup');
});

/**
 * Generate a connection loss during a "downloadBodyReps" job caused by
 * getBody() with the downloadBodyReps option specified; the job should
 * experience an aborted-retry error, then get retried and the body should still
 * show up.
 */
TD.commonCase('Connection loss during single body fetch', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eCheck = T.lazyLogger('check');

  // we already tested the backoff logic up above; don't need it here.
  zeroTimeoutErrbackoffTimer();

  var testFolder = testAccount.do_createTestFolder(
    'test_err_downloadBodyReps',
    { count: 1, age: { days: 0 }, age_incr: { days: 1 } });

  var folderView = testAccount.do_openFolderView(
    'sync', testFolder,
    null,
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  T.action(eCheck, 'download body: fail, check, succeed', function() {
    // the first time will fail and the (already owned/used) connection will die
    testAccount.expect_runOp(
      'downloadBodyReps',
      // no save because nothing will be accomplished and we optimize that case
      { local: false, server: true, save: false,
        release: 'deadconn', error: 'aborted-retry' });

    // we will have to run a check!
    testAccount.expect_runOp(
      'downloadBodyReps',
      { mode: 'check', local: false, server: true, save: false });

    // the second time will get a new connection and succeed
    testAccount.expect_runOp(
      'downloadBodyReps',
      { local: false, server: true, conn: true, release: false, save: 'server' });

    // rig the connection to explode on our fetch.
    FawltySocketFactory.getMostRecentLiveSocket().doOnSendText([
      {
        match: /FETCH/,
        actions: ['instant-close'],
      }
    ]);

    // expect the body to be present
    eCheck.expect_namedValueD('body downloaded', true);

    // trigger the download
    var header = folderView.slice.items[0], body;
    header.getBody({ downloadBodyReps: true }, function(_body) {
      body = _body;

      // the body gets returned immediately and the body fetch happens
      // asynchronously after that.
      body.onchange = function() {
        eCheck.namedValueD('body downloaded',
                          body.bodyReps[0].isDownloaded,
                          body);
      };
    });
  });
  T.group('cleanup');
});

}); // end define

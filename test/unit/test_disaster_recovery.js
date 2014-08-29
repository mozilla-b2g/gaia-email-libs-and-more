define(['rdcommon/testcontext', './resources/th_main', 'slog', 'exports'],
       function($tc, $th_imap, slog, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_disaster_recovery' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('Releases mutex during botched sync', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse }),
      eSync = T.lazyLogger('check');

  var folder = testAccount.do_createTestFolder(
    'test_disaster_recovery',
    { count: 5, age: { days: 0 }, age_incr: { days: 1 } });

  T.action('Tell socket.ondata to do horrible things', eSync, function(T) {

    var acct = testUniverse.universe.accounts[0]._receivePiece;
    var conn = acct._ownedConns[0].conn;
    conn.client.socket.ondata = function() {
      throw new Error('wtf');
    };

  });

  testAccount.do_viewFolder(
    'syncs', folder,
    null, null,
    { failure: true,
      nosave: true,
      noexpectations: true,
    expectFunc: function() {
      RT.reportActiveActorThisStep(testAccount.eImapAccount);
      testAccount.eImapAccount.expect_reuseConnection();
      // When the error is thrown, we'll kill the connection:
      testAccount.eImapAccount.expect_deadConnection();

      var log = new slog.LogChecker(T, RT, 'disaster');

      // Make sure we capture an error with the proper details.
      log.mustLog('disaster-recovery:exception', function(details) {
        return (details.accountId === '0' &&
                details.error.message === 'wtf');
      });

      // There should not be a job running now.
      log.mustNotLog('disaster-recovery:finished-job');

      // We _did_ have the mutex; ensure it is released.
      // Note that this release will occur as a result of the connection loss,
      // not as a result of any additional bookkeeping on our part.
      log.mustLog('mailslice:mutex-released',
                  { folderId: folder.id, err: 'aborted' });
    }});
});

TD.commonCase('Releases both mutexes and job op during move', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('check');

  var sourceFolder = testAccount.do_createTestFolder(
    'test_move_source',
    { count: 5, age: { days: 1 }, age_incr: { days: 1 } });

  var targetFolder = testAccount.do_createTestFolder(
    'test_move_target',
    { count: 0 });

  var sourceView = testAccount.do_openFolderView(
    'sourceView', sourceFolder,
    { count: 5, full: 5, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  var targetView = testAccount.do_openFolderView(
    'targetView', targetFolder,
    { count: 0, full: 0, flags: 0, changed: 0, deleted: 0},
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });


  T.action('Tell socket.ondata to do horrible things', eSync, function(T) {

    var acct = testUniverse.universe.accounts[0]._receivePiece;
    var conn = acct._ownedConns[0].conn;
    conn.client.socket.ondata = function() {
      throw new Error('wtf');
    };

  });

  T.action('try the move job op', testAccount, function() {
    var headers = sourceView.slice.items,
        toMove = headers[1];

    testAccount.expect_runOp(
      'move',
      { local: true, server: true, save: true });

    var log = new slog.LogChecker(T, RT, 'disaster');
    // The local job will succeed and it will release its mutexes without having
    // experienced any errors.
    log.mustLog('mailslice:mutex-released',
                { folderId: sourceFolder.id, err: null });
    log.mustLog('mailslice:mutex-released',
                { folderId: targetFolder.id, err: null });

    // When the error is thrown, we'll kill the connection:
    testAccount.eImapAccount.expect_deadConnection();

    testAccount.expect_runOp(
      'move',
      { mode: 'check' });

    // Force the socket to act horribly.
    var acct = testUniverse.universe.accounts[0]._receivePiece;
    var conn = acct._ownedConns[0].conn;
    conn.client.socket.ondata = function() {
      throw new Error('wtf');
    };

    // Make sure we capture an error with the proper details.
    log.mustLog('disaster-recovery:exception', function(details) {
      return (details.accountId === '0' &&
              details.error.message === 'wtf');
    });

    // Then the jobDoneCallback gets invoked.  It will release the mutexes.
    log.mustLog('mailslice:mutex-released',
                { folderId: sourceFolder.id, err: 'disastrous-error' });
    log.mustLog('mailslice:mutex-released',
                { folderId: targetFolder.id, err: 'disastrous-error' });

    // And we mark when the jobDoneCallback finishes running.
    log.mustLog('disaster-recovery:finished-job', function(details) {
      return details.error.message === 'wtf';
    });


    testUniverse.MailAPI.moveMessages(
      [toMove], targetFolder.mailFolder);
  });

});


}); // end define

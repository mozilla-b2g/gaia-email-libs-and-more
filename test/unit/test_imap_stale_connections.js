define(['rdcommon/testcontext', './resources/th_main',
        'imap',
        'mailapi/syncbase', 'exports'],
       function($tc, $th_imap, $imap, $sync, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_imap_stale_connections' }, null, [$th_imap.TESTHELPER], ['app']);


function thunkTimeouts(lazyLogger) {
  var timeouts = [];
  function thunkedSetTimeout(func, delay) {
    lazyLogger.namedValue('incoming:setTimeout', delay);
    return timeouts.push(func);
  }
  function thunkedClearTimeout(idx) {
    lazyLogger.event('incoming:clearTimeout');
  }

  $imap.TEST_useStaleTimeoutFuncs(thunkedSetTimeout, thunkedClearTimeout);

  return function fireThunkedTimeouts() {
    while (timeouts.length) {
      (timeouts.shift())();
    }
  };
}

/**
 * Test that we properly kill connections which haven't received any
 * data after STALE_CONNECTION_TIMEOUT_MS milliseconds.
 */
TD.commonCase('stale connections', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A', { universe: testUniverse }),
      eSync = T.lazyLogger('sync');

  // NB: The KILL_CONNECTIONS_WHEN_JOBLESS setting won't affect this
  // test, because it is explicitly disabled in th_main.
  var fireTimeouts = thunkTimeouts(eSync);

  T.group('full sync, normal connection timeout');
  var fullSyncFolder = testAccount.do_createTestFolder(
    'test_initial_full_sync',
    { count: 4, age: { days: 0 }, age_incr: { days: 1 } });

  testAccount.do_viewFolder(
    'syncs', fullSyncFolder,
    { count: 4, full: 4, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: null },
    { syncedToDawnOfTime: true });

  T.action('connection should die', eSync,
           testAccount.eImapAccount, function() {
    var acct = testUniverse.universe.accounts[0]._receivePiece;
    var conn = acct._ownedConns[0].conn;

    eSync.expect_event('incoming:clearTimeout');
    testAccount.eImapAccount.expect_deadConnection();
    eSync.expect_namedValue('closed', true);

    conn.on('close', function() {
      eSync.namedValue('closed', true);
    });

    fireTimeouts();
  });

  T.group('cleanup');
});

}); // end define

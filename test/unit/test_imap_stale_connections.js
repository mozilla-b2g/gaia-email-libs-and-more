define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');


/**
 * Test that we properly kill connections which haven't received any
 * data after STALE_CONNECTION_TIMEOUT_MS milliseconds.
 */
return new LegacyGelamTest('stale connections', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A', { universe: testUniverse }),
      eSync = T.lazyLogger('sync');

  // NB: The KILL_CONNECTIONS_WHEN_JOBLESS setting won't affect this
  // test, because it is explicitly disabled in th_main.

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

    // Since we had previously incorrectly hooked up the router's
    // sendMessage logic, double-check here to ensure we actually fire
    // off the 'close' event, i.e. the one we care about (rather than
    // 'end') per bug 1048487:
    var socket = conn.client.socket;
    var origSendMessage = socket._sendMessage.bind(socket);
    socket._sendMessage = function(evt, args) {
      if (evt !== 'write') {
        eSync.log('sending event', evt);
        socket._sendMessage = origSendMessage;
      }
      origSendMessage(evt, args);
    };

    eSync.expect('sending event',  'close');
    eSync.expect('closed',  true);
    testAccount.eImapAccount.expect('deadConnection');

    var onclose = conn.onclose;
    conn.onclose = function() {
      eSync.log('closed', true);
      onclose && onclose.apply(conn, arguments);
    };

    conn.client.onidle();
  });

  T.group('cleanup');
});

}); // end define

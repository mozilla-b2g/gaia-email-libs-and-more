define(['rdcommon/testcontext', './resources/th_main',
        './resources/fault_injecting_socket', 'errbackoff', 'exports'],
       function($tc, $th_imap, $fawlty, $errbackoff, exports) {
var FawltySocketFactory = $fawlty.FawltySocketFactory;

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_imap_dead_connection' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('timelySyncSearch retries given a dead conn', function(T, RT) {
  T.group('setup');
  T.check('reset', function() {
    FawltySocketFactory.reset();
  });

  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse }),
      eCheck = T.lazyLogger('check');

  var testFolder = testAccount.do_createTestFolder(
    'test_imap_dead_connection',
    { count: 4, age: { days: 1 }, age_incr: { days: 1 } });

  T.group('sync / open view');
  var testView = testAccount.do_openFolderView(
    'syncs', testFolder,
    { count : 4, full: 4, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.group('connection dies on refresh');
  testAccount.do_refreshFolderView(
    testView,
    { count : 4, full: 0, flags: 4, deleted: 0 },
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false },
    { failure: false,
      expectFunc: function() {
        RT.reportActiveActorThisStep(testAccount.eImapAccount);
        testAccount.eImapAccount.expect_deadConnection();
        testAccount.eImapAccount.expect_createConnection();
        testAccount.eImapAccount.expect_reuseConnection();

        // Have the socket close on us when we go to say more stuff to the
        // server.  The sync process should be active at this point.
        FawltySocketFactory.getMostRecentLiveSocket().doOnSendText(
          [{ match: true, actions: ['instant-close'] }]);
      }});

  T.group('ensure no infinite loop, i.e. second retry fails.');

  testAccount.do_refreshFolderView(
    testView,
    { count : 4, full: 0, flags: 0, deleted: 0 },
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false },
    { failure: 'deadconn',
      expectFunc: function() {
        RT.reportActiveActorThisStep(testAccount.eImapAccount);
        testAccount.eImapAccount.expect_deadConnection();
        testAccount.eImapAccount.expect_createConnection();
        testAccount.eImapAccount.expect_reuseConnection();
        testAccount.eImapAccount.expect_deadConnection();

        // Close the second connection attempt (the retry).
        FawltySocketFactory.precommand(
          testAccount.imapHost, testAccount.imapPort,
          { cmd: 'close-on-send', match: /UID SEARCH/ });

        // Close the _first_ connection (already open).
        FawltySocketFactory.getMostRecentLiveSocket().doOnSendText(
          [{ match: true, actions: ['instant-close'] }]);
      }});

  T.check('reset / no precommands', function() {
    FawltySocketFactory.assertNoPrecommands(
      testAccount.imapHost, testAccount.imapPort);
    FawltySocketFactory.reset();
  });
});

}); // end define

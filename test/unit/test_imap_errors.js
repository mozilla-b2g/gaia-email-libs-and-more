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
 * We test the following here:
 * -
 *
 * We test these things elsewhere:
 * -
 *
 * We want tests for the following (somewhere):
 * - Sync connect failure: Can't talk to the server at all.
 * - Sync login failure: The server does not like our credentials.
 * - Sync connection loss on SELECT. (This is during the opening of the folder
 *    connection and therefore strictly before actual synchronization logic is
 *    under way.)
 * - Sync connection loss on UID SEARCH. (This is during the _reliaSearch call,
 *    which theoretically is restartable without any loss of sync logic state.)
 * - Sync connection loss on UID FETCH. (This is within the sync process itself,
 *    which theoretically is restartable if the IMAP connection maintains its
 *    state and re-establishes.)
 *
 * - Failures in the (auto)configuration process (covering all the enumerated
 *   failure values we define.)
 **/

// Use the faulty socket implementation.
load('resources/fault_injecting_socket.js');

var TD = $tc.defineTestsFor(
  { id: 'test_imap_errors' }, null, [$th_imap.TESTHELPER], ['app']);


/**
 * Attempt to connect to a server with immediate failures each time (that we
 * have already established an account for).  Verify that we do the backoff
 * logic and eventually give up, waiting for a manual retrigger.
 */
TD.commonCase('failure to connect, backoff check', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A',
                            { universe: testUniverse, restored: false }),
      eSync = T.lazyLogger('sync');



});

/**
 * Change our password to the wrong password, then try to open a new connection
 * and make sure we notice and the bad password event fires.
 */
TD.commonCase('bad password login failure', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('sync');

});

TD.commonCase('general/unknown login failure', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('sync');

});

/**
 * Sometimes a server doesn't want to let us into a folder.  For example,
 * Yahoo will do this.
 */
TD.commonCase('IMAP server forbids SELECT', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('sync');

});


TD.commonCase('IMAP connection loss on SELECT', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('sync');

});

TD.commonCase('IMAP connection loss on FETCH', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('sync');

});


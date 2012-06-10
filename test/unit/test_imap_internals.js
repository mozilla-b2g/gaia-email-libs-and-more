/**
 * Test IMAP (and general MailUniverse) functionality that should not vary
 * based on the server.  This covers:
 *
 * - Persistence of account data through setup and teardown.
 * - That teardown kills IMAP connections.
 **/

load('resources/loggest_test_framework.js');

var TD = $tc.defineTestsFor(
  { id: 'test_imap_internals' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('account persistence', function(T) {
  T.group('create universe, account');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A', { universe: testUniverse });

  T.group('cram messages in, sync them');

  T.group('cleanly shutdown account, universe');
  testUniverse.do_saveState();
  testUniverse.do_shutdown();

  T.group('reload account, universe');
  // rebind to new universe / (loaded) account
  testUniverse = T.actor('testUniverse', 'U2',
                         { restored: ['imap+smtp'] });
  testAccount = T.actor('testImapAccount', 'A2',
                        { universe: testUniverse, restored: true });

  T.group('verify sync is not starting from scratch');


  T.group('mutate messages, verify sync');

  T.group('save account state');
  testUniverse.do_saveState();

  T.group('uncleanly shutdown account, universe');
  testUniverse.do_shutdown();

  T.group('reload account, universe; check syncs detect nothing new');
  testUniverse = T.actor('testUniverse', 'U3',
                         { restored: ['imap+smtp'] });
  testAccount = T.actor('testImapAccount', 'A3',
                        { universe: testUniverse, restored: true });

  T.group('cleanup');
});

function run_test() {
  runMyTests(5);
}

/**
 * Test our IMAP sync logic under non-pathological conditions.  We exercise
 * logic with a reasonable number of messages.  Test cases that involve folders
 * with ridiculous numbers of messages and/or huge gaps in time which will take
 * a while to run and/or might upset the IMAP servers are handled in
 * `test_imap_excessive.js`.
 *
 * Our tests:
 * - Verify that live synchronization provides the expected results where
 *   the messages come direct from the connection as they are added.
 * -
 **/

load('resources/loggest_test_framework.js');

var TD = $tc.defineTestsFor(
  { id: 'blah' }, null, [$th_imap.TESTHELPER], ['app']);

// This does not need to match up with the constant our app actually uses.
const INITIAL_SYNC_DAYS = 7,
      // This is the number of messages after which the sync logic will
      // declare victory and stop filling.
      INITIAL_FILL_SIZE = 15;

TD.commonCase('folder sync', function(T) {
  T.group('setup');
  var testAccount = T.actor('testImapAccount', 'A'),
      eSync = T.lazyLogger('sync');

  /**
   * Try and synchronize an empty folder.  Verify that our slice completes with
   * minimal legwork.
   */
  T.group('sync empty folder');
  var emptyFolder = testAccount.createTestFolder(
    'test_empty_sync', { count: 0 });
  T.action(eSync, 'sync folder', function() {
    eSync.expect_namedValue('syncCount', 0);

    var slice = MailAPI.viewFolderMessages(emptyFolder.mailFolder);
    slice.oncomplete = function() {
      eSync.namedValue('syncCount', slice.items.length);
      slice.die();
    };
  });
  testAccount.do_pretendToBeOffline(true);
  T.check(eSync, 'check persisted data', function() {
    eSync.expect_namedValue('syncCount', 0);

    var slice = MailAPI.viewFolderMessages(emptyFolder.mailFolder);
    slice.oncomplete = function() {
      eSync.namedValue('syncCount', slice.items.length);
      slice.die();
    };
  });
  testAccount.do_pretendToBeOffline(false);

  /**
   * Perform a folder sync where our initial time fetch window contains all of
   * the messages in the folder.
   */
  T.group('initial interval is full sync');
  var fullSyncFolder = testAccount.createTestFolder(
    'test_initial_full_sync',
    { count: 4, age: { days: 0 }, age_incr: { days: 1 } });
  T.action(eSync, 'sync folder', function() {
    eSync.expect_namedValue('syncCount', 4);
    eSync.expect_namedValue('first subject',
                            testFolder.messages[0].headerInfo.subject);
    eSync.expect_namedValue('last subject',
                            testFolder.messages[3].headerInfo.subject);

    var slice = MailAPI.viewFolderMessages(fullSync.mailFolder);
    slice.oncomplete = function() {
      eSync.namedValue('syncCount', slice.items.length);
      eSync.namedValue('first subject', slice.items[0].subject);
      eSync.namedValue('last subject', slice.items[3].subject);
      slice.die();
    };
  });

  /**
   * Perform a folder sync where our initial time fetch window contains more
   * messages than we want and there are even more messages beyond.
   */
  T.group('saturated initial interval');
      // This should provide 17 messages in our 7 day range.
  var saturatedFolder = testAccount.createTestFolder(
    'test_saturated_sync',
    { count: 24, age: { days: 0 }, age_incr: { hours: 9 } });
  T.action('sync folder', function() {
  });

  /**
   * Perform a folder sync where we need to search multiple time ranges in order
   * to gain a sufficient number of messages.
   */
  T.group('initial fetch spans multiple time ranges');
      // will fetch: 3, 7, 7, 7 = 24
  var msearchFolder = testAccount.createTestFolder(
    'test_multiple_ranges',
    { count: 30, age: { days: 0 }, age_incr: { days: 2 } });
  T.action('sync folder', function() {
  });

  T.group('cleanup');
});

function run_test() {
  runMyTests(20); // we do a lot of appending...
}

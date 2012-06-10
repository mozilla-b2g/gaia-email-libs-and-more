/**
 * Test our mutation operations: altering message flags, moving messages,
 * and deleting messages (which will frequently just involve moving a message
 * to the trash folder).
 *
 * We want to ensure that our mutation operations:
 * - Apply changes locally to the database / messages upon issue, so that the
 *   user can see the result of their changes almost immediately even when they
 *   are offline or experiencing high latency.
 *
 * - Are undoable.  Every operation should be able to be reversed.
 *
 * - Are no-ops from a server perspective when undone before being played to the
 *   server.
 *
 * Our mutation logic is also somewhat tested by `test_imap_general.js` which
 * relies on it to effect mutations to test the sync logic.  However, those
 * tests do not perform local database changes since then the sync logic might
 * not get properly tested.
 *
 * Things we do not test here:
 * - Server failure cases.  Those will be handled elsewhere since we want to
 *   perform fault injection and that cannot usefully be done against a real
 *   server.  (While these tests can and should be run against real servers.)
 **/

load('resources/loggest_test_framework.js');

var TD = $tc.defineTestsFor(
  { id: 'test_imap_mutation' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('mutate flags', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A', { universe: testUniverse }),
      eSync = T.lazyLogger('sync'),
      numMessages = 7;

  var testFolder = testAccount.do_createTestFolder(
    'test_mutation_flags',
    { count: numMessages, age_incr: { days: 1 } });
  var folderView = testAccount.do_openFolderView(
    'folderView', testFolder,
    { count: numMessages, full: numMessages, flags: 0, deleted: 0 });

  var doHeaderExps = null, undoHeaderExps = null, undoOps = null,
      applyManips = null;

  /**
   * This tests our local modifications and that our state stays the same once
   * we have told the server our changes and then synced against them.
   *
   * TODO: We want to support custom-tags, but it's not a v1 req, so we're
   * punting it.
   */
  T.group('offline manipulation; released to server');
  testUniverse.do_pretendToBeOffline(true);
  T.action('manipulate flags, hear local changes, no network use by',
           testAccount, testAccount.eImapAccount, function() {
    // by mentioning testAccount we ensure that we will assert if we see a
    // reuseConnection from it.
    var headers = folderView.slice.items,
        toMarkRead = headers[1],
        toStar = headers[2],
        toMarkRepliedTo = headers[3],
        toMarkForwarded = headers[4],
        toMarkJunk = headers[5],
        toStarAndMarkRead = headers[6];

    applyManips = function applyManips() {
      undoOps = [];

      undoOps.push(toMarkRead.setRead(true));
      undoOps.push(toStar.setStarred(true));
      // these should normally only set by the composition mechanism on send:
      undoOps.push(toMarkRepliedTo.modifyTags(['\\Answered']));
      undoOps.push(toMarkForwarded.modifyTags(['$Forwarded']));
      // This may end up with a custom move-heuristic if it gets better supported
      undoOps.push(toMarkJunk.modifyTags(['$Junk']));
      // this normally would not be a single transaction...
      undoOps.push(toStarAndMarkRead.modifyTags(['\\Seen', '\\Flagged']));
    };
    applyManips();
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount.eImapAccount.expect_runOp_begin('local_do', 'modtags');
      testAccount.eImapAccount.expect_runOp_end('local_do', 'modtags');
    }

    doHeaderExps = {
      changes: [
        [toStar, 'isStarred', true],
        [toMarkRead, 'isRead', true],
        [toMarkRepliedTo, 'isRepliedTo', true],
        [toMarkForwarded, 'isForwarded', true],
        [toMarkJunk, 'isJunk', true],
        [toStarAndMarkRead, 'isStarred', true, 'isRead', true],
      ],
      deletions: []
    };
    undoHeaderExps = {
      changes: [
        [toStar, 'isStarred', false],
        [toMarkRead, 'isRead', false],
        [toMarkRepliedTo, 'isRepliedTo', false],
        [toMarkForwarded, 'isForwarded', false],
        [toMarkJunk, 'isJunk', false],
        [toStarAndMarkRead, 'isStarred', false, 'isRead', false],
      ],
      deletions: []
    };
    testAccount.expect_headerChanges(folderView, doHeaderExps, 'roundtrip');
  });
  T.action('go online, see changes happen for', testAccount.eImapAccount,
           eSync, function() {
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount.eImapAccount.expect_runOp_begin('do', 'modtags');
      testAccount.eImapAccount.expect_runOp_end('do', 'modtags');
    }
    eSync.expect_event('ops-done');

    window.navigator.connection.TEST_setOffline(false);
    MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
      eSync.event('ops-done');
    });
  });

  // The refresh should result in us refreshing our flags but not hearing about
  // any changes because our predictions should be 100% accurate.
  testAccount.do_refreshFolderView(
    folderView,
    { count: numMessages, full: 0, flags: numMessages, deleted: 0 },
    { changes: [], deletions: [] });

  T.group('undo while offline; released to server');
  testUniverse.do_pretendToBeOffline(true);
  T.action('undo!', testAccount.eImapAccount, eSync, function() {
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount.eImapAccount.expect_runOp_begin('local_undo', 'modtags');
      testAccount.eImapAccount.expect_runOp_end('local_undo', 'modtags');
    }

    undoOps.forEach(function(x) { x.undo(); });
    testAccount.expect_headerChanges(folderView, undoHeaderExps, 'roundtrip');
  });

  T.action('go online, see undos happen for', testAccount.eImapAccount,
           eSync, function() {
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount.eImapAccount.expect_runOp_begin('undo', 'modtags');
      testAccount.eImapAccount.expect_runOp_end('undo', 'modtags');
    }
    eSync.expect_event('ops-done');

    window.navigator.connection.TEST_setOffline(false);
    MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
      eSync.event('ops-done');
    });
  });

  // The refresh should result in us refreshing our flags but not hearing about
  // any changes because our predictions should be 100% accurate.
  testAccount.do_refreshFolderView(
    folderView,
    { count: numMessages, full: 0, flags: numMessages, deleted: 0 },
    { changes: [], deletions: [] });

  /**
   * If we undo an operation without having told it to the server, it should be
   * locally and remotely as if it never happened.
   */
  T.group('offline manipulation undone while offline (never online)');
  testUniverse.do_pretendToBeOffline(true);
  T.action('manipulate flags, hear local changes',
           testAccount, testAccount.eImapAccount, function() {
    applyManips();
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount.eImapAccount.expect_runOp_begin('local_do', 'modtags');
      testAccount.eImapAccount.expect_runOp_end('local_do', 'modtags');
    }
    testAccount.expect_headerChanges(folderView, doHeaderExps, 'roundtrip');
  });
  T.action('trigger undo ops, hear local changes',
           testAccount, testAccount.eImapAccount, function() {
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount.eImapAccount.expect_runOp_begin('local_undo', 'modtags');
      testAccount.eImapAccount.expect_runOp_end('local_undo', 'modtags');
    }

    undoOps.forEach(function(x) { x.undo(); });
    testAccount.expect_headerChanges(folderView, undoHeaderExps, 'roundtrip');
  });
  T.action('go online, see nothing happen',
           testAccount.eImapAccount, eSync, function() {
    // eImapAccount is listed so we complain if we see ops run
    eSync.expect_event('ops-clear');

    window.navigator.connection.TEST_setOffline(false);
    MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
      eSync.event('ops-clear');
    });
  });
  // The refresh should result in us refreshing our flags but not hearing about
  // any changes because nothing should have happened!
  testAccount.do_refreshFolderView(
    folderView,
    { count: numMessages, full: 0, flags: numMessages, deleted: 0 },
    { changes: [], deletions: [] });

  /**
   * Do a single manipulation and its undo while online, cases we haven't tried
   * yet.  By doing a single manipulation we avoid any races between local_do
   * and do events (which could happen).
   */
  T.group('online manipulation and undo');
  T.action('star the 0th dude', testAccount, testAccount.eImapAccount, eSync,
           function() {
    // - expectations
    var toStar = folderView.slice.items[0];
    testAccount.eImapAccount.expect_runOp_begin('local_do', 'modtags');
    testAccount.eImapAccount.expect_runOp_end('local_do', 'modtags');
    testAccount.eImapAccount.expect_runOp_begin('do', 'modtags');
    testAccount.eImapAccount.expect_runOp_end('do', 'modtags');
    eSync.expect_event('ops-done');

    doHeaderExps = {
      changes: [
        [toStar, 'isStarred', true],
      ],
      deletions: [],
    };
    undoHeaderExps = {
      changes: [
        [toStar, 'isStarred', false],
      ],
      deletions: [],
    };

    // - do it!
    undoOps = [toStar.setStarred(true)];

    testAccount.expect_headerChanges(folderView, doHeaderExps, 'roundtrip');
    // We need to roundtrip before waiting on the ops because the latter does
    // not cross the bridge itself.
    MailAPI.ping(function() {
      MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
        eSync.event('ops-done');
      });
    });
  });
  // Sync should find no changes from our predictive changes
  testAccount.do_refreshFolderView(
    folderView,
    { count: numMessages, full: 0, flags: numMessages, deleted: 0 },
    { changes: [], deletions: [] });
  T.action('undo the starring', testAccount, testAccount.eImapAccount, eSync,
           function() {
    testAccount.eImapAccount.expect_runOp_begin('local_undo', 'modtags');
    testAccount.eImapAccount.expect_runOp_end('local_undo', 'modtags');
    testAccount.eImapAccount.expect_runOp_begin('undo', 'modtags');
    testAccount.eImapAccount.expect_runOp_end('undo', 'modtags');
    eSync.expect_event('ops-done');

    undoOps[0].undo();
    testAccount.expect_headerChanges(folderView, undoHeaderExps, 'roundtrip');
    // We need to roundtrip before waiting on the ops because the latter does
    // not cross the bridge itself.
    MailAPI.ping(function() {
      MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
        eSync.event('ops-done');
      });
    });
  });
  // And again, sync should find no changes
  testAccount.do_refreshFolderView(
    folderView,
    { count: numMessages, full: 0, flags: numMessages, deleted: 0 },
    { changes: [], deletions: [] });

  T.group('cleanup');
});

function run_test() {
  runMyTests(5);
}

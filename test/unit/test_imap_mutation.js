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

TD.DISABLED_commonCase('mutate flags', function(T) {
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
    { count: numMessages, full: numMessages, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false });

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
    testAccount.expect_headerChanges(
      folderView, doHeaderExps,
      { top: true, bottom: true, grow: false },
      'roundtrip');
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
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false });

  T.group('undo while offline; released to server');
  testUniverse.do_pretendToBeOffline(true);
  T.action('undo!', testAccount.eImapAccount, eSync, function() {
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount.eImapAccount.expect_runOp_begin('local_undo', 'modtags');
      testAccount.eImapAccount.expect_runOp_end('local_undo', 'modtags');
    }

    undoOps.forEach(function(x) { x.undo(); });
    testAccount.expect_headerChanges(
      folderView, undoHeaderExps,
      { top: true, bottom: true, grow: false },
      'roundtrip');
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
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false });

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
    testAccount.expect_headerChanges(
      folderView, doHeaderExps,
      { top: true, bottom: true, grow: false },
      'roundtrip');
  });
  T.action('trigger undo ops, hear local changes',
           testAccount, testAccount.eImapAccount, function() {
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount.eImapAccount.expect_runOp_begin('local_undo', 'modtags');
      testAccount.eImapAccount.expect_runOp_end('local_undo', 'modtags');
    }

    undoOps.forEach(function(x) { x.undo(); });
    testAccount.expect_headerChanges(
      folderView, undoHeaderExps,
      { top: true, bottom: true, grow: false },
      'roundtrip');
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
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false });

  /**
   * Verify that mutations and their undos survive a restart.
   */
  T.group('offline manipulation, shutdown, startup, go online, see mutations');
  testUniverse.do_pretendToBeOffline(true);
  T.action('manipulate flags, hear local changes',
           testAccount, testAccount.eImapAccount, function() {
    applyManips();
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount.eImapAccount.expect_runOp_begin('local_do', 'modtags');
      testAccount.eImapAccount.expect_runOp_end('local_do', 'modtags');
    }
    testAccount.expect_headerChanges(
      folderView, doHeaderExps,
      { top: true, bottom: true, grow: false },
      'roundtrip');
  });
  testAccount.do_closeFolderView(folderView);
  testUniverse.do_saveState();
  testUniverse.do_shutdown();
  var testUniverse2 = T.actor('testUniverse', 'U2'),
      testAccount2 = T.actor('testImapAccount', 'A2',
                             { universe: testUniverse2, restored: true }),
      testFolder2 = testAccount2.do_useExistingFolder(
                      'test_mutation_flags', '#2', testFolder),
      folderView2 = testAccount2.do_openFolderView(
        'folderView2', testFolder2,
        { count: numMessages, full: numMessages, flags: 0, deleted: 0 },
        { top: true, bottom: true, grow: false });
  T.action('go online, see changes happen for', testAccount2.eImapAccount,
           eSync, function() {
    var created = false;
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount2.eImapAccount.expect_runOp_begin('check', 'modtags');
      testAccount2.eImapAccount.expect_runOp_end('check', 'modtags');
      testAccount2.eImapAccount.expect_runOp_begin('do', 'modtags');
      // We will acquire a connection for the first operation because the slice
      // was created when we were offline and so did not acquire a conncetion.
      // The connection will not be released once the operations complete
      // because the slice is still open.
      if (!created) {
        testAccount2.expect_connection();
        created = true;
      }
      testAccount2.eImapAccount.expect_runOp_end('do', 'modtags');
    }
    eSync.expect_event('ops-done');

    window.navigator.connection.TEST_setOffline(false);
    MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
      eSync.event('ops-done');
    });
  });

  T.group('offline undo, shutdown, startup, go online, see undos');
  testUniverse2.do_pretendToBeOffline(true);
  T.action('undo!', testAccount2.eImapAccount, eSync, function() {
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount2.eImapAccount.expect_runOp_begin('local_undo', 'modtags');
      testAccount2.eImapAccount.expect_runOp_end('local_undo', 'modtags');
    }

    // NB: our undoOps did not usefully survive the restart; they are still
    // hooked up to the old universe/bridge, and so are not useful.  However,
    // their longterm identifiers are still valid, so we can just directly
    // issue the undo requests against the universe.  (If we issued new
    // mutations without restarting, we could have those be alive and use them,
    // but we don't need coverage for that.
    undoOps.forEach(function(x) {
      MailUniverse.undoMutation(x._longtermIds);
    });
    testAccount2.expect_headerChanges(
      folderView2, undoHeaderExps,
      { top: true, bottom: true, grow: false },
      'roundtrip');
  });
  testUniverse2.do_saveState();
  testUniverse2.do_shutdown();
  var testUniverse3 = T.actor('testUniverse', 'U3'),
      testAccount3 = T.actor('testImapAccount', 'A3',
                             { universe: testUniverse3, restored: true }),
      testFolder3 = testAccount3.do_useExistingFolder(
        'test_mutation_flags', '#3', testFolder2),
      folderView3 = testAccount3.do_openFolderView(
        'folderView3', testFolder3,
        { count: numMessages, full: numMessages, flags: 0, deleted: 0 },
        { top: true, bottom: true, grow: false });

  T.action('go online, see undos happen for', testAccount3.eImapAccount,
           eSync, function() {
    var created = false;
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount3.eImapAccount.expect_runOp_begin('check', 'modtags');
      testAccount3.eImapAccount.expect_runOp_end('check', 'modtags');
      testAccount3.eImapAccount.expect_runOp_begin('undo', 'modtags');
      if (!created) {
        testAccount3.expect_connection();
        created = true;
      }
      testAccount3.eImapAccount.expect_runOp_end('undo', 'modtags');
    }
    eSync.expect_event('ops-done');

    window.navigator.connection.TEST_setOffline(false);
    MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
      eSync.event('ops-done');
    });
  });


  /**
   * Do a single manipulation and its undo while online, cases we haven't tried
   * yet.  By doing a single manipulation we avoid any races between local_do
   * and do events (which could happen).
   */
  T.group('online manipulation and undo');
  T.action('star the 0th dude', testAccount3, testAccount3.eImapAccount, eSync,
           function() {
    // - expectations
    var toStar = folderView3.slice.items[0];
    testAccount3.eImapAccount.expect_runOp_begin('local_do', 'modtags');
    testAccount3.eImapAccount.expect_runOp_end('local_do', 'modtags');
    testAccount3.eImapAccount.expect_runOp_begin('do', 'modtags');
    testAccount3.eImapAccount.expect_runOp_end('do', 'modtags');
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

    testAccount3.expect_headerChanges(
      folderView3, doHeaderExps,
      { top: true, bottom: true, grow: false },
      'roundtrip');
    // We need to roundtrip before waiting on the ops because the latter does
    // not cross the bridge itself.
    MailAPI.ping(function() {
      MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
        eSync.event('ops-done');
      });
    });
  });
  // Sync should find no changes from our predictive changes
  testAccount3.do_refreshFolderView(
    folderView3,
    { count: numMessages, full: 0, flags: numMessages, deleted: 0 },
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false });
  T.action('undo the starring', testAccount3, testAccount3.eImapAccount, eSync,
           function() {
    testAccount3.eImapAccount.expect_runOp_begin('local_undo', 'modtags');
    testAccount3.eImapAccount.expect_runOp_end('local_undo', 'modtags');
    testAccount3.eImapAccount.expect_runOp_begin('undo', 'modtags');
    testAccount3.eImapAccount.expect_runOp_end('undo', 'modtags');
    eSync.expect_event('ops-done');

    undoOps[0].undo();
    testAccount3.expect_headerChanges(
      folderView3, undoHeaderExps,
      { top: true, bottom: true, grow: false },
      'roundtrip');
    // We need to roundtrip before waiting on the ops because the latter does
    // not cross the bridge itself.
    MailAPI.ping(function() {
      MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
        eSync.event('ops-done');
      });
    });
  });
  // And again, sync should find no changes
  testAccount3.do_refreshFolderView(
    folderView3,
    { count: numMessages, full: 0, flags: numMessages, deleted: 0 },
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false });

  T.group('cleanup');
});

/**
 * Create a source folder and a target folder with some messages in the source
 * folder.
 */
TD.commonCase('move/trash messages', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A',
                            { universe: testUniverse, restored: false /* XXX true*/ }),
      eSync = T.lazyLogger('sync');

  var sourceFolder = testAccount.do_createTestFolder(
    'test_move_source',
    { count: 5, age_incr: { days: 1 } });
  var targetFolder = testAccount.do_createTestFolder(
    'test_move_target',
    { count: 0 });

  var sourceView = testAccount.do_openFolderView(
    'sourceView', sourceFolder,
    { count: 5, full: 5, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false });
  var targetView = testAccount.do_openFolderView(
    'sourceView', targetFolder,
    { count: 0, full: 0, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false });
  var trashFolder = testAccount.do_useExistingFolder('Trash', '', null);
  // open the trash but don't care what's in there, we just care about deltas
  var trashView = testAccount.do_openFolderView('trashView', trashFolder, null);

  T.group('offline manipulation; released to server');

  var undoMove = null, undoDelete = null;

  testUniverse.do_pretendToBeOffline(true);
  T.action('move/trash messages',
           testAccount, testAccount.eImapAccount, function() {
    // by mentioning testAccount we ensure that we will assert if we see a
    // reuseConnection from it.
    var headers = sourceView.slice.items,
        toMove = headers[1],
        toDelete = headers[2];

    testAccount.eImapAccount.expect_runOp_begin('local_do', 'move');
    testAccount.eImapAccount.expect_runOp_end('local_do', 'move');
    testAccount.eImapAccount.expect_runOp_begin('local_do', 'delete');
    testAccount.eImapAccount.expect_runOp_end('local_do', 'delete');

    testAccount.expect_headerChanges(
      targetView,
      { additions: [toMove], changes: [], deletions: [] },
      null, /* done after 1 event: */ 1);
    // While the removal of toMove actually happens before the target hears
    // about it, since we are waiting for 2 events, we will see it happen here
    // once the toDelete removal fires.
    testAccount.expect_headerChanges(
      sourceView,
      { additions: [], changes: [], deletions: [toMove, toDelete] },
      null, /* done after 2 events: */ 2);
    testAccount.expect_headerChanges(
      trashView,
      { additions: [toDelete], changes: [], deletions: [] },
      null, /* done after 1 event: */ 1);

    undoMove = toMove.moveMessage(targetFolder.mailFolder);
    undoDelete = toDelete.deleteMessage();
  });
  T.action('go online, see changes happen for', testAccount.eImapAccount,
           eSync, function() {
    testAccount.eImapAccount.expect_runOp_begin('do', 'move');
    testAccount.eImapAccount.expect_runOp_end('do', 'move');
    testAccount.eImapAccount.expect_runOp_begin('do', 'delete');
    testAccount.eImapAccount.expect_runOp_end('do', 'delete');
    eSync.expect_event('ops-done');

    window.navigator.connection.TEST_setOffline(false);
    MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
      eSync.event('ops-done');
    });
  });

});

function run_test() {
  runMyTests(15);
}

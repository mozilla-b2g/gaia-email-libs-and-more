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
 * - Gracefully handle the disappearance of messages, both in changes
 *   originating from the server (presumably from another client), as well as
 *   local manipulations like moving a message.
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
      testAccount = T.actor('testAccount', 'A', { universe: testUniverse }),
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
           testAccount, testAccount.eOpAccount, function() {
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
      testAccount.expect_runOp(
        'modtags',
        { local: true, server: false, save: true });
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
      6);
  });
  T.action('go online, see changes happen for', testAccount.eOpAccount,
           eSync, function() {
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount.expect_runOp(
        'modtags',
        { local: false, server: true });
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
      testAccount.expect_runOp(
        'modtags',
        { mode: 'undo', local: true, server: false, save: true });
    }

    undoOps.forEach(function(x) { x.undo(); });
    testAccount.expect_headerChanges(
      folderView, undoHeaderExps,
      { top: true, bottom: true, grow: false },
      6);
  });

  T.action('go online, see undos happen for', testAccount.eImapAccount,
           eSync, function() {
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount.expect_runOp(
        'modtags',
        { mode: 'undo', local: false, server: true });
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
      testAccount.expect_runOp(
        'modtags',
        { local: true, server: false, save: true });
    }
    testAccount.expect_headerChanges(
      folderView, doHeaderExps,
      { top: true, bottom: true, grow: false },
      6);
  });
  T.action('trigger undo ops, hear local changes',
           testAccount, testAccount.eImapAccount, function() {
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount.expect_runOp(
        'modtags',
        { mode: 'undo', local: true, server: false, save: true });
    }

    undoOps.forEach(function(x) { x.undo(); });
    testAccount.expect_headerChanges(
      folderView, undoHeaderExps,
      { top: true, bottom: true, grow: false },
      6);
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
      testAccount.expect_runOp(
        'modtags',
        { local: true, server: false, save: true });
    }
    testAccount.expect_headerChanges(
      folderView, doHeaderExps,
      { top: true, bottom: true, grow: false },
      6);
  });
  testAccount.do_closeFolderView(folderView);
  testUniverse.do_saveState();
  testUniverse.do_shutdown();
  var testUniverse2 = T.actor('testUniverse', 'U2'),
      testAccount2 = T.actor('testAccount', 'A2',
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
      testAccount2.expect_runOp(
        'modtags',
        { mode: 'check' });
      testAccount2.expect_runOp(
        'modtags',
        // We will acquire a connection for the first operation because the
        // slice was created when we were offline and so did not acquire a
        // connection.  The connection will not be released once the operations
        // complete because the slice is still open.
        { local: false, server: true, conn: !created, release: false });
      created = true;
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
      testAccount2.expect_runOp(
        'modtags',
        { mode: 'undo', local: true, server: false, save: true });
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
      6);
  });
  testUniverse2.do_saveState();
  testUniverse2.do_shutdown();
  var testUniverse3 = T.actor('testUniverse', 'U3'),
      testAccount3 = T.actor('testAccount', 'A3',
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
      testAccount3.expect_runOp(
        'modtags',
        { mode: 'check' });
      testAccount3.expect_runOp(
        'modtags',
        // We will acquire a connection for the first operation because the
        // slice was created when we were offline and so did not acquire a
        // connection.  The connection will not be released once the operations
        // complete because the slice is still open.
        { mode: 'undo', local: false, server: true,
          conn: !created, release: false, save: false });
      created = true;
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
    testAccount3.expect_runOp(
      'modtags',
      { local: true, server: true, save: true });
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
      1);
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
    testAccount3.expect_runOp(
      'modtags',
      { mode: 'undo', local: true, server: true, save: true });
    eSync.expect_event('ops-done');

    undoOps[0].undo();
    testAccount3.expect_headerChanges(
      folderView3, undoHeaderExps,
      { top: true, bottom: true, grow: false },
      1);
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


  /**
   * Create a situation for modtags where by the time the online 'do' operation
   * runs, the message has disappeared from the local database.  Note that this
   * is different from the case where our own 'move' or 'delete' logic has
   * caused the message to disappear, since that leaves behind the server id
   * information for us that the 'do' job needs in the suidToServerId map.
   */
  T.group('modtags gracefully handles missing messages');
  testUniverse3.do_pretendToBeOffline(true);
  var purgeStarredHeader;
  T.action('star message', function() {
    testAccount3.expect_runOp(
      'modtags',
      { local: true, server: false, save: true });
    purgeStarredHeader = folderView3.slice.items[0];
    purgeStarredHeader.setStarred(true);
  });
  T.action('fake delete the header', function() {
    testAccount3.fakeServerMessageDeletion(purgeStarredHeader);
  });
  T.action('go online, see the job run to completion', function() {
    testAccount3.expect_runOp(
      'modtags',
      { local: false, server: true, save: false });
    window.navigator.connection.TEST_setOffline(false);
  });

  T.group('cleanup');
  // save our state so the next unit test doesn't try and re-run our ops
  testUniverse3.do_saveState();
});

/**
 * Create a source folder and a target folder with some messages in the source
 * folder.
 */
TD.commonCase('move/trash messages', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('sync');

  // Our test requires 4 connections because we hold open 3 views at once and
  // then perform a move to a folder that doesn't have an open view.
  T.action('set max conns to 4 ', function() {
    testAccount.imapAccount._maxConnsAllowed = 4;
  });

  var sourceFolder = testAccount.do_createTestFolder(
    'test_move_source',
    { count: 5, age_incr: { days: 1 } });
  var targetFolder = testAccount.do_createTestFolder(
    'test_move_target',
    { count: 0 });
  var blindTargetFolder = testAccount.do_createTestFolder(
    'test_move_blind_target',
    { count: 0 });
  var trashFolder = testAccount.do_createTestFolder(
    'Trash',
    { count: 0 });

  var sourceView = testAccount.do_openFolderView(
    'sourceView', sourceFolder,
    { count: 5, full: 5, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false });
  var targetView = testAccount.do_openFolderView(
    'targetView', targetFolder,
    { count: 0, full: 0, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false });
  // open the trash but don't care what's in there, we just care about deltas
  var trashView = testAccount.do_openFolderView('trashView', trashFolder, null);

  T.group('offline manipulation; released to server');

  var undoMoveBlind = null, undoMoveVisible = null, undoDelete = null;

  testUniverse.do_pretendToBeOffline(true);
  T.action('move/trash messages',
           testAccount, testAccount.eImapAccount, function() {
    // by mentioning testAccount we ensure that we will assert if we see a
    // reuseConnection from it.
    var headers = sourceView.slice.items,
        toMoveBlind = headers[1],
        toMoveVisible = headers[2],
        toDelete = headers[3];

    testAccount.expect_runOp(
      'move',
      { local: true, server: false, save: true });
    testAccount.expect_runOp(
      'move',
      { local: true, server: false, save: true });
    testAccount.expect_runOp(
      'delete',
      { local: true, server: false, save: true });

    testAccount.expect_headerChanges(
      targetView,
      { additions: [toMoveVisible], changes: [], deletions: [] },
      null, /* done after 1 event: */ 1);
    // While the removal of toMove actually happens before the target hears
    // about it, since we are waiting for 2 events, we will see it happen here
    // once the toDelete removal fires.
    testAccount.expect_headerChanges(
      sourceView,
      { additions: [], changes: [],
        deletions: [toMoveBlind, toMoveVisible, toDelete] },
      null, /* done after 3 events: */ 3);
    testAccount.expect_headerChanges(
      trashView,
      { additions: [toDelete], changes: [], deletions: [] },
      null, /* done after 1 event: */ 1);

    undoMoveBlind = toMoveBlind.moveMessage(blindTargetFolder.mailFolder);
    undoMoveVisible = toMoveVisible.moveMessage(targetFolder.mailFolder);
    undoDelete = toDelete.deleteMessage();
  });
  T.action('go online, see changes happen for', testAccount.eImapAccount,
           eSync, function() {
    testAccount.expect_runOp(
      'move',
      { local: false, server: true, save: false, conn: true });
    testAccount.expect_runOp(
      'move',
      { local: false, server: true, save: false });
    testAccount.expect_runOp(
      'delete',
      { local: false, server: true, save: false });
    eSync.expect_event('ops-done');

    window.navigator.connection.TEST_setOffline(false);
    MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
      eSync.event('ops-done');
    });
  });

  testUniverse.do_pretendToBeOffline(true);
  T.action('delete from trash', testAccount, testAccount.eImapAccount,
           function() {
    var headers = trashView.slice.items,
        toDelete = headers[0];

    testAccount.expect_runOp(
      'delete',
      { local: true, server: false, save: true });
    testAccount.expect_headerChanges(
      trashView,
      { additions: [], changes: [], deletions: [toDelete] },
      null, /* done after 1 event: */ 1);
    toDelete.deleteMessage();
  });
  T.action('go online, see changes happen for', testAccount.eImapAccount,
           eSync, function() {
    testAccount.expect_runOp(
      'delete',
      { local: false, server: true, save: false });
    eSync.expect_event('ops-done');

    window.navigator.connection.TEST_setOffline(false);
    MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
      eSync.event('ops-done');
    });
  });

  /**
   * While offline, queue a local tag mutation followed by a move.  Then, go
   * online and ensure that when the message ends up in the target folder after
   * the ops have run that it has the altered state.
   */
  T.group('move does not interfere with online ops');
  testUniverse.do_pretendToBeOffline(true);
  var moveStarMailHeader;
  T.action('tag message then move', function() {
    testAccount.expect_runOp(
      'modtags',
      { local: true, server: false, save: true });
    testAccount.expect_runOp(
      'move',
      { local: true, server: false, save: true });

    // use the 0th message in source; chronologically it will end up 0 in the
    // target folder too.
    moveStarMailHeader = sourceView.slice.items[0];
    moveStarMailHeader.setStarred(true);
    moveStarMailHeader.moveMessage(targetFolder.mailFolder);
  });
  T.action('go online, wait for ops to complete', eSync, function() {
    testAccount.expect_runOp(
      'modtags',
      { local: false, server: true, save: false });
    testAccount.expect_runOp(
      'move',
      { local: false, server: true, save: false });
    eSync.expect_event('ops-done');

    window.navigator.connection.TEST_setOffline(false);
    MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
      eSync.event('ops-done');
    });
  });
  // Refresh the folder to make sure the current state of the target folder
  // matches our expectation.  This will fail if the flags on the message are
  // not what they are locally.
  testAccount.do_refreshFolderView(
    targetView,
    { count: 2, full: 0, flags: 2, deleted: 0 },
    // note: the empty changes assertion
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false });
  // And this is an extra sanity check on that delta-check.
  T.check(eSync, 'moved message is starred', function() {
    eSync.expect_namedValue('moved message subject',
                            moveStarMailHeader.subject);
    eSync.expect_namedValue('starred', true);

    var actualHeader = targetView.slice.items[0];
    eSync.namedValue('moved message subject', actualHeader.subject);
    eSync.namedValue('starred', actualHeader.isStarred);
  });
});

function run_test() {
  runMyTests(15);
}

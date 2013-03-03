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
const $ascp = require('activesync/codepages');
const FilterType = $ascp.AirSync.Enums.FilterType;

var TD = $tc.defineTestsFor(
  { id: 'test_mutation' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('mutate flags', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A', { universe: testUniverse }),
      eSync = T.lazyLogger('sync'),
      eAccount = TEST_PARAMS.type === 'imap' ? testAccount.eImapAccount :
                                               testAccount.eAccount,
      numMessages = 7,
      flagCount = TEST_PARAMS.type === 'imap' ? numMessages : 0;

  var testFolder = testAccount.do_createTestFolder(
    'test_mutation_flags',
    { count: numMessages, age_incr: { days: 1 } });
  var folderView = testAccount.do_openFolderView(
    'folderView', testFolder,
    { count: numMessages, full: numMessages, flags: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

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
        toStarAndMarkRead = headers[3],
        toMarkRepliedTo = headers[4],
        toMarkForwarded = headers[5],
        toMarkJunk = headers[6];

    applyManips = function applyManips() {
      undoOps = [];

      undoOps.push(toMarkRead.setRead(true));
      undoOps.push(toStar.setStarred(true));
      // this normally would not be a single transaction...
      undoOps.push(toStarAndMarkRead.modifyTags(['\\Seen', '\\Flagged']));

      if (TEST_PARAMS.type === 'imap') {
        // these should normally only set by the composition mechanism on send:
        undoOps.push(toMarkRepliedTo.modifyTags(['\\Answered']));
        undoOps.push(toMarkForwarded.modifyTags(['$Forwarded']));
        // This may end up with a custom move-heuristic if it gets better
        // supported
        undoOps.push(toMarkJunk.modifyTags(['$Junk']));
      }
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
        [toStarAndMarkRead, 'isStarred', true, 'isRead', true],
      ],
      deletions: []
    };
    undoHeaderExps = {
      changes: [
        [toStar, 'isStarred', false],
        [toMarkRead, 'isRead', false],
        [toStarAndMarkRead, 'isStarred', false, 'isRead', false],
      ],
      deletions: []
    };

    if (TEST_PARAMS.type === 'imap') {
      doHeaderExps.changes.push(
        [toMarkRepliedTo, 'isRepliedTo', true],
        [toMarkForwarded, 'isForwarded', true],
        [toMarkJunk, 'isJunk', true]
      );
      undoHeaderExps.changes.push(
        [toMarkRepliedTo, 'isRepliedTo', false],
        [toMarkForwarded, 'isForwarded', false],
        [toMarkJunk, 'isJunk', false]
      );
    }

    testAccount.expect_headerChanges(
      folderView, doHeaderExps,
      { top: true, bottom: true, grow: false },
      doHeaderExps.changes.length);
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
    { count: numMessages, full: 0, flags: flagCount, deleted: 0 },
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.group('undo while offline; released to server');
  testUniverse.do_pretendToBeOffline(true);
  T.action('undo!', eAccount, eSync, function() {
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount.expect_runOp(
        'modtags',
        { mode: 'undo', local: true, server: false, save: true });
    }

    undoOps.forEach(function(x) { x.undo(); });
    testAccount.expect_headerChanges(
      folderView, undoHeaderExps,
      { top: true, bottom: true, grow: false },
      undoHeaderExps.changes.length);
  });

  T.action('go online, see undos happen for', eAccount,
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
    { count: numMessages, full: 0, flags: flagCount, deleted: 0 },
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  /**
   * If we undo an operation without having told it to the server, it should be
   * locally and remotely as if it never happened.
   */
  T.group('offline manipulation undone while offline (never online)');
  testUniverse.do_pretendToBeOffline(true);
  T.action('manipulate flags, hear local changes',
           testAccount, eAccount, function() {
    applyManips();
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount.expect_runOp(
        'modtags',
        { local: true, server: false, save: true });
    }
    testAccount.expect_headerChanges(
      folderView, doHeaderExps,
      { top: true, bottom: true, grow: false },
      doHeaderExps.changes.length);
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
      doHeaderExps.changes.length);
  });
  T.action('go online, see nothing happen', eAccount, eSync, function() {
    // eAccount is listed so we complain if we see ops run
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
    { count: numMessages, full: 0, flags: flagCount, deleted: 0 },
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  /**
   * Verify that mutations and their undos survive a restart.
   */
  T.group('offline manipulation, shutdown, startup, go online, see mutations');
  testUniverse.do_pretendToBeOffline(true);
  T.action('manipulate flags, hear local changes',
           testAccount, eAccount, function() {
    applyManips();
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount.expect_runOp(
        'modtags',
        { local: true, server: false, save: true });
    }
    testAccount.expect_headerChanges(
      folderView, doHeaderExps,
      { top: true, bottom: true, grow: false },
      doHeaderExps.changes.length);
  });
  testAccount.do_closeFolderView(folderView);
  testUniverse.do_saveState();
  testUniverse.do_shutdown();
  var testUniverse2 = T.actor('testUniverse', 'U2'),
      testAccount2 = T.actor('testAccount', 'A2',
                             { universe: testUniverse2, restored: true }),
      eAccount2 = TEST_PARAMS.type === 'imap' ? testAccount2.eImapAccount :
                                               testAccount2.eAccount,
      testFolder2 = testAccount2.do_useExistingFolder(
                      'test_mutation_flags', '#2', testFolder),
      folderView2 = testAccount2.do_openFolderView(
        'folderView2', testFolder2,
        { count: numMessages, full: numMessages, flags: 0, deleted: 0 },
        { top: true, bottom: true, grow: false });
  T.action('go online, see changes happen for', eAccount2,
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
  T.action('undo!', eAccount, eSync, function() {
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
      undoHeaderExps.changes.length);
  });
  testUniverse2.do_saveState();
  testUniverse2.do_shutdown();
  var testUniverse3 = T.actor('testUniverse', 'U3'),
      testAccount3 = T.actor('testAccount', 'A3',
                             { universe: testUniverse3, restored: true }),
      eAccount3 = TEST_PARAMS.type === 'imap' ? testAccount3.eImapAccount :
                                               testAccount3.eAccount,
      testFolder3 = testAccount3.do_useExistingFolder(
        'test_mutation_flags', '#3', testFolder2),
      folderView3 = testAccount3.do_openFolderView(
        'folderView3', testFolder3,
        { count: numMessages, full: numMessages, flags: 0, deleted: 0 },
        { top: true, bottom: true, grow: false });

  T.action('go online, see undos happen for', eAccount3, eSync, function() {
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
  T.action('star the 0th dude', testAccount3, eAccount3, eSync, function() {
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
      doHeaderExps.changes.length);
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
    { count: numMessages, full: 0, flags: flagCount, deleted: 0 },
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
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
      undoHeaderExps.changes.length);
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
    { count: numMessages, full: 0, flags: flagCount, deleted: 0 },
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });


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
      eAccount = TEST_PARAMS.type === 'imap' ? testAccount.eImapAccount :
                                               testAccount.eAccount,
      eSync = T.lazyLogger('sync');

  if (TEST_PARAMS.type === 'imap') {
    // Our test requires 4 connections because we hold open 3 views at once and
    // then perform a move to a folder that doesn't have an open view.
    T.action('set max conns to 4 ', function() {
      testAccount.imapAccount._maxConnsAllowed = 4;
    });
  }

  // XXX: We want messages at least 10 days old so that the next test case
  // (batch moves/deletes) works! This is because slices don't want to expand
  // into the past, so if we make sure the first message added is the oldest,
  // we should be safe.
  var sourceFolder = testAccount.do_createTestFolder(
    'test_move_source',
    { count: 5, age: { days: 1 }, age_incr: { hours: 1 } });
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
    { count: 5, full: 5, flags: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  var targetView = testAccount.do_openFolderView(
    'targetView', targetFolder,
    { count: 0, full: 0, flags: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  // open the trash but don't care what's in there, we just care about deltas
  var trashView = testAccount.do_openFolderView(
    'trashView', trashFolder, null, null,
    { syncedToDawnOfTime: 'ignore' });

  T.group('offline manipulation; released to server');

  var undoMoveBlind = null, undoMoveVisible = null, undoDelete = null;

  testUniverse.do_pretendToBeOffline(true);
  T.action('move/trash messages',
           testAccount, eAccount, function() {
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
  T.action('go online, see changes happen for', eAccount,
           eSync, function() {
    var save = TEST_PARAMS.type === 'imap' ? false : 'server';
    testAccount.expect_runOp(
      'move',
      { local: false, server: true, save: save, conn: true });
    testAccount.expect_runOp(
      'move',
      { local: false, server: true, save: save });
    testAccount.expect_runOp(
      'delete',
      { local: false, server: true, save: save });
    eSync.expect_event('ops-done');

    window.navigator.connection.TEST_setOffline(false);
    MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
      eSync.event('ops-done');
    });
  });

  testUniverse.do_pretendToBeOffline(true);
  T.action('delete from trash', testAccount, eAccount, function() {
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
  T.action('go online, see changes happen for', eAccount, eSync, function() {
    var save = TEST_PARAMS.type === 'imap' ? false : 'server';
    testAccount.expect_runOp(
      'delete',
      { local: false, server: true, save: save });
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
    { count: 2, full: 0, flags: TEST_PARAMS.type === 'imap' ? 2 : 0,
      deleted: 0 },
    // note: the empty changes assertion
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  // And this is an extra sanity check on that delta-check.
  T.check(eSync, 'moved message is starred', function() {
    eSync.expect_namedValue('moved message subject',
                            moveStarMailHeader.subject);
    eSync.expect_namedValue('starred', true);

    var actualHeader = targetView.slice.items[0];
    eSync.namedValue('moved message subject', actualHeader.subject);
    eSync.namedValue('starred', actualHeader.isStarred);
  });
  // Make sure we have the expected number of messages in the original folder.
  testAccount.do_refreshFolderView(
    sourceView,
    { count: 1, full: 0, flags: TEST_PARAMS.type === 'imap' ? 1 : 0,
      deleted: 0 },
    // note: the empty changes assertion
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false });
});

/**
 * Create a source folder and a target folder with some messages in the source
 * folder, and then move them around in batches.
 */
TD.commonCase('batch move/trash messages', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eAccount = TEST_PARAMS.type === 'imap' ? testAccount.eImapAccount :
                                               testAccount.eAccount,
      eSync = T.lazyLogger('sync');

  if (TEST_PARAMS.type === 'imap') {
    // Our test requires 4 connections because we hold open 3 views at once and
    // then perform a move to a folder that doesn't have an open view.
    T.action('set max conns to 4 ', function() {
      testAccount.imapAccount._maxConnsAllowed = 4;
    });
  }

  var sourceFolder = testAccount.do_createTestFolder(
    'test_move_source',
    { count: 10, age_incr: { hours: 1 } });
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
    { count: 10, full: 10, flags: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  var targetView = testAccount.do_openFolderView(
    'targetView', targetFolder,
    { count: 0, full: 0, flags: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  // open the trash but don't care what's in there, we just care about deltas
  var trashView = testAccount.do_openFolderView(
    'trashView', trashFolder,
    null,
    null,
    { syncedToDawnOfTime: 'ignore' });

  T.group('offline manipulation; released to server');

  var undoMoveBlind = null, undoMoveVisible = null, undoDelete = null;

  testUniverse.do_pretendToBeOffline(true);
  T.action('move/trash messages',
           testAccount, eAccount, function() {
    // by mentioning testAccount we ensure that we will assert if we see a
    // reuseConnection from it.
    var headers = sourceView.slice.items,
        toMoveBlind = headers.slice(1, 3),
        toMoveVisible = headers.slice(3, 5),
        toDelete = headers.slice(5, 7),
        allMutations = headers.slice(1, 7);

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
      { additions: toMoveVisible, changes: [], deletions: [] },
      null, /* done after 2 events: */ 2);
    // While the removal of toMove actually happens before the target hears
    // about it, since we are waiting for 4 events, we will see it happen here
    // once the toDelete removals fire.
    testAccount.expect_headerChanges(
      sourceView,
      { additions: [], changes: [],
        deletions: allMutations },
      null, /* done after 6 events: */ 6);
    testAccount.expect_headerChanges(
      trashView,
      { additions: toDelete, changes: [], deletions: [] },
      null, /* done after 2 events: */ 2);

    undoMoveBlind = MailAPI.moveMessages(toMoveBlind,
                                         blindTargetFolder.mailFolder);
    undoMoveVisible = MailAPI.moveMessages(toMoveVisible,
                                           targetFolder.mailFolder);
    undoDelete = MailAPI.deleteMessages(toDelete);
  });

  T.action('go online, see changes happen for', eAccount,
           eSync, function() {
    var save = TEST_PARAMS.type === 'imap' ? false : 'server';
    testAccount.expect_runOp(
      'move',
      { local: false, server: true, save: save, conn: true });
    testAccount.expect_runOp(
      'move',
      { local: false, server: true, save: save });
    testAccount.expect_runOp(
      'delete',
      { local: false, server: true, save: save });
    eSync.expect_event('ops-done');

    window.navigator.connection.TEST_setOffline(false);
    MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
      eSync.event('ops-done');
    });
  });

  testUniverse.do_pretendToBeOffline(true);
  T.action('delete from trash', testAccount, eAccount, function() {
    var headers = trashView.slice.items,
        toDelete = headers.slice(0, 2);

    testAccount.expect_runOp(
      'delete',
      { local: true, server: false, save: true });
    testAccount.expect_headerChanges(
      trashView,
      { additions: [], changes: [], deletions: toDelete },
      null, /* done after 2 events: */ 2);
    MailAPI.deleteMessages(toDelete);
  });
  T.action('go online, see changes happen for', eAccount, eSync, function() {
    var save = TEST_PARAMS.type === 'imap' ? false : 'server';
    testAccount.expect_runOp(
      'delete',
      { local: false, server: true, save: save });
    eSync.expect_event('ops-done');

    window.navigator.connection.TEST_setOffline(false);
    MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
      eSync.event('ops-done');
    });
  });
});

function run_test() {
  runMyTests(20);
}

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
 * - Do not screw up when the requested manipulation already reflects the
 *   *local* state of the message.  For example, marking a message as (un)read
 *   that already has that state should not mess up our per-folder unread count.
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

define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var $airsync = require('activesync/codepages/AirSync');
const FilterType = $airsync.Enums.FilterType;

var allTests = [];

function commonCase(name, fn) {
  allTests.push(new LegacyGelamTest(name, fn));
}

commonCase('deleting headers midflight', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A', { universe: testUniverse }),
      numMessages = 2,
      toDelete = {};

  var testFolder = testAccount.do_createTestFolder(
    'test_mutation_midflight_deletion',
    { count: numMessages, age_incr: { days: 1 } });

  var folderView = testAccount.do_openFolderView(
    'folderView2', testFolder,
    { count: numMessages, full: numMessages, flags: 0, changed: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.group('attempt to modify while deleting');

  T.action('delete header midflight', function() {
     var header =
       toDelete.headerInfo = folderView.slice.items[numMessages - 1];

    // begin the process of updating this header
    header.setRead(true);

    testAccount.expect_runOp(
      'modtags',
      // server is false because in the local case we will notice we did no
      // work locally so there is no work to do on the server and will set
      // it to skip.
      { local: true, server: false, save: true }
    );

    // fake delete it *locally*
    testAccount.fakeServerMessageDeletion(header);
  });

  T.group('cleanup');
  testAccount.do_closeFolderView(folderView);
  // we must do this to ensure the operation's success state gets persisted
  testUniverse.do_saveState();
});

commonCase('mutate flags', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A', {
        universe: testUniverse,
        restored: true
      }),
      eSync = T.lazyLogger('sync'),
      numMessages = 7;

  // Ugh, so we need to make sure the front-end rep has actually heard
  // everything so we can use expect_unread to assert.  Unfortunately there are
  // cases where expect_unread needs to in fact execute synchronously, so we
  // can't sprinkle this in there.  I'm just fighting an intermittent here and
  // we just need our new test refactoring infra.  Ugh ugh ugh.
  function do_ensureFrontEndUpdatesReceived() {
    T.action('(wait for ping roundtrip to ensure front-end is up-to-date',
             eSync, ')', function() {
      eSync.expect('ping');
      testAccount.MailAPI.ping(function() {
        eSync.log('ping');
      });
    });
  }

  var testFolder = testAccount.do_createTestFolder(
    'test_mutation_flags',
    { count: numMessages, age_incr: { days: 1 } });
  var folderView = testAccount.do_openFolderView(
    'folderView', testFolder,
    { count: numMessages, full: numMessages, flags: 0, changed: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.check('initial unread counts', eSync, function() {
    // We added 7 messages and they all start out unread.
    testAccount.expect_unread('Before messages are read', testFolder, eSync, 7);
  });

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
           testAccount, testAccount.eOpAccount, eSync, function() {
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

  do_ensureFrontEndUpdatesReceived();
  T.check('unread counts after local op mutations', eSync, function() {
    // We had 7 unread and then read 2, so down to 5.
    testAccount.expect_unread('Unread count after local ops', testFolder,
      eSync, 5);
  });

  T.action('go online, see changes happen for', testAccount.eOpAccount,
           eSync, function() {
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount.expect_runOp(
        'modtags',
        { local: false, server: true });
    }
    eSync.expect('ops-done');

    // The online op should not affect the post-local-op unread count.
    eSync.expect('Unread count still',  5);

    testUniverse.pretendToBeOffline(false);
    testUniverse.universe.waitForAccountOps(
      testUniverse.universe.accounts[0],
      function() {
        eSync.log('ops-done');
        var unread = testUniverse.universe
          .getFolderStorageForFolderId(testFolder.id)
          .folderMeta.unreadCount;
        eSync.log('Unread count still', unread);
      }.bind(this));
  });

  // The refresh should result in us refreshing our flags but not hearing about
  // any changes because our predictions should be 100% accurate.
  testAccount.do_refreshFolderView(
    folderView,
    { count: numMessages, full: 0, flags: numMessages, changed: 0, deleted: 0 },
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.group('undo while offline; released to server');
  testUniverse.do_pretendToBeOffline(true);
  T.action('undo!', testAccount.eFolderAccount, eSync, function() {
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

  do_ensureFrontEndUpdatesReceived();
  T.check('unread counts after local op undo ops', eSync, function() {
    // We undo both mark read operations, so our 5 is back up to 7.
    testAccount.expect_unread('Unread count after local ops', testFolder,
      eSync, 7);
  });

  T.action('go online, see undos happen for', testAccount.eFolderAccount,
           eSync, function() {
    for (var nOps = undoOps.length; nOps > 0; nOps--) {
      testAccount.expect_runOp(
        'modtags',
        { mode: 'undo', local: false, server: true });
    }
    eSync.expect('ops-done');
    // The server ops should not impact the unread count.
    eSync.expect('Unread count after server op undo',  7);

    testUniverse.pretendToBeOffline(false);
    testUniverse.universe.waitForAccountOps(
      testUniverse.universe.accounts[0],
      function() {
        eSync.log('ops-done');
        var unread = testUniverse.universe
          .getFolderStorageForFolderId(testFolder.id)
          .folderMeta.unreadCount;
        eSync.log('Unread count after server op undo', unread);
      });
  });

  // The refresh should result in us refreshing our flags but not hearing about
  // any changes because our predictions should be 100% accurate.
  testAccount.do_refreshFolderView(
    folderView,
    { count: numMessages, full: 0, flags: numMessages, changed: 0, deleted: 0 },
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
           testAccount, testAccount.eFolderAccount, function() {
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
  T.action('go online, see nothing happen', testAccount.eFolderAccount, eSync,
           function() {
    // eAccount is listed so we complain if we see ops run
    eSync.expect('ops-clear');

    testUniverse.pretendToBeOffline(false);
    testUniverse.universe.waitForAccountOps(
      testUniverse.universe.accounts[0],
      function() {
        eSync.log('ops-clear');
      });
  });
  // The refresh should result in us refreshing our flags but not hearing about
  // any changes because nothing should have happened!
  testAccount.do_refreshFolderView(
    folderView,
    { count: numMessages, full: 0, flags: numMessages, changed: 0, deleted: 0 },
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  /**
   * Verify that mutations and their undos survive a restart.
   */
  T.group('offline manipulation, shutdown, startup, go online, see mutations');
  testUniverse.do_pretendToBeOffline(true);
  T.action('manipulate flags, hear local changes',
           testAccount, testAccount.eFolderAccount, function() {
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
  var testUniverse2 = T.actor('TestUniverse', 'U2', { old: testUniverse }),
      testAccount2 = T.actor('TestAccount', 'A2',
                             { universe: testUniverse2, restored: true }),
      eAccount2 = testAccount2.eFolderAccount,
      testFolder2 = testAccount2.do_useExistingFolder(
                      'test_mutation_flags', '#2', testFolder),
      folderView2 = testAccount2.do_openFolderView(
        'folderView2', testFolder2,
        { count: numMessages, full: numMessages, flags: 0, changed: 0,
          deleted: 0 },
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
    eSync.expect('ops-done');

    testUniverse2.pretendToBeOffline(false);
    testUniverse2.universe.waitForAccountOps(
      testUniverse2.universe.accounts[0],
      function() {
        eSync.log('ops-done');
      });
  });

  T.group('offline undo, shutdown, startup, go online, see undos');
  testUniverse2.do_pretendToBeOffline(true);
  T.action('undo!', eAccount2, eSync, function() {
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
      testUniverse2.universe.undoMutation(x._longtermIds);
    });
    testAccount2.expect_headerChanges(
      folderView2, undoHeaderExps,
      { top: true, bottom: true, grow: false },
      undoHeaderExps.changes.length);
  });
  testUniverse2.do_saveState();
  testUniverse2.do_shutdown();
  var testUniverse3 = T.actor('TestUniverse', 'U3', { old: testUniverse2 }),
      testAccount3 = T.actor('TestAccount', 'A3',
                             { universe: testUniverse3, restored: true }),
      eAccount3 = testAccount3.eFolderAccount,
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
    eSync.expect('ops-done');

    testUniverse3.pretendToBeOffline(false);
    testUniverse3.universe.waitForAccountOps(
      testUniverse3.universe.accounts[0],
      function() {
        eSync.log('ops-done');
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
    eSync.expect('ops-done');

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
    testUniverse3.MailAPI.ping(function() {
      testUniverse3.universe.waitForAccountOps(
        testUniverse3.universe.accounts[0],
        function() {
          eSync.log('ops-done');
        });
    });
  });
  // Sync should find no changes from our predictive changes
  testAccount3.do_refreshFolderView(
    folderView3,
    { count: numMessages, full: 0, flags: numMessages, changed: 0, deleted: 0 },
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  T.action('undo the starring', testAccount3, testAccount3.eImapAccount, eSync,
           function() {
    testAccount3.expect_runOp(
      'modtags',
      { mode: 'undo', local: true, server: true, save: true });
    eSync.expect('ops-done');

    undoOps[0].undo();
    testAccount3.expect_headerChanges(
      folderView3, undoHeaderExps,
      { top: true, bottom: true, grow: false },
      undoHeaderExps.changes.length);
    // We need to roundtrip before waiting on the ops because the latter does
    // not cross the bridge itself.
    testUniverse3.MailAPI.ping(function() {
      testUniverse3.universe.waitForAccountOps(
        testUniverse3.universe.accounts[0],
        function() {
          eSync.log('ops-done');
        });
    });
  });
  // And again, sync should find no changes
  testAccount3.do_refreshFolderView(
    folderView3,
    { count: numMessages, full: 0, flags: numMessages, changed: 0, deleted: 0 },
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });


  /**
   * Create a situation for modtags where by the time the online 'do' operation
   * runs, the message has disappeared from the local database.  Note that this
   * is different from the case where our own 'move' or 'delete' logic has
   * caused the message to disappear, since that leaves behind the server id
   * information for us that the 'do' job needs in the suidToServerId map.
   *
   * We do *not* run this test for POP3 since POP3 has no server ops for this
   * and performing the setup.  There used to a problem with structured cloning
   * the _TEST_blah properties that would be left as a byproduct of this
   * operation, but bug 921050 will have addressed that by making them
   * non-enumerable.
   */
  if (TEST_PARAMS.type !== 'pop3') {
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
      testAccount3.deleteMessagesOnServerButNotLocally(
        folderView3, [0]);
      testAccount3.fakeServerMessageDeletion(purgeStarredHeader);
    });
    T.action('go online, see the job run to completion', function() {
      testAccount3.expect_runOp(
        'modtags',
        { local: false, server: true, save: false });
      testUniverse3.pretendToBeOffline(false);
    });
  }

  T.group('cleanup');
  // save our state so the next unit test doesn't try and re-run our ops
  testUniverse3.do_saveState();
});

/**
 * We want to test redundant flag changes, especially read/unread status which
 * impacts our folder's unread count.
 *
 * We do this as a black-box test.  Specifically, we test:
 * - Requesting a redundant change to a single message.  Something that could
 *   potentially result in us being clever enough to never queue or run a job
 *   at all.  Although for now we'll assume the job happens.  The test can just
 *   be revised when that changes.
 * - Requesting a batch change to a set of messages where it's redundant for
 *   some messages and not redundant for other messages.
 *
 * Note that this test is only run for IMAP servers because right now only
 * IMAP lets us insert messages into a folder with them already marked as read.
 * We could make this work with ActiveSync if we cared, but POP3 is sorta a
 * hassle.  But we don't actually get any extra coverage with them, so they
 * get auto-bailed.
 */
commonCase('redundant flag changes', function(T, RT) {
  var TEST_PARAMS = RT.envOptions;
  // Auto-bail for non-IMAP, see above.
  if (TEST_PARAMS.type !== 'imap') {
    return;
  }

  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A', {
        universe: testUniverse,
        restored: true
      }),
      eSync = T.lazyLogger('sync');

  // Create a folder that looks like so to us:
  // [unread    read   unread read   unread read unread read]
  // and which our operations will be, in this order with ASCII art positioning
  // being significant:
  //         (redundant)
  //  (redundant)
  //  (semi-redundant setRead(true))
  //                                 (semi-redundant setRead(false))

  var testFolder = testAccount.do_createTestFolder(
    'test_redundant_mutation_flags',
    { count: 4, read: false, age_incr: { days: 1 } });
  testAccount.do_addMessagesToFolder(
    testFolder,
    { count: 4, read: true, age: { hours: 2 }, age_incr: { days: 1 } });
  var folderView = testAccount.do_openFolderView(
    'folderView', testFolder,
    { count: 8, full: 8, flags: 0, changed: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  var eAsync = T.lazyLogger();
  /**
   * Helper to ensure that each message has the expected read state (true for
   * read, false for unread) and that our counts also match up.  This
   * automatically waits for a ping round-trip before checking since job
   */
  function do_assertReadStates(expectedStates) {
    T.check('assert read states', eSync, function() {
      eAsync.expect('asyncReady');

      var expectedUnread = expectedStates.reduce(function(unreadTally, isRead) {
          return unreadTally + (isRead ? 0 : 1);
        }, 0);

      eSync.expect('readStates',  expectedStates);
      testAccount.MailAPI.ping(function() {
        var actualStates = folderView.slice.items.map(function(header) {
          return header.isRead;
        });
        eSync.log('readStates', actualStates);
        testAccount.expect_unread('unread tally', testFolder, eSync,
                                  expectedUnread);
        eAsync.log('asyncReady');
      });
    });
  }

  do_assertReadStates([false, true, false, true, false, true, false, true]);

  T.group('single redundant setRead(true)');
  T.action('items[1].setRead(true)', function() {
    testAccount.expect_runOp(
      'modtags',
      { local: true, server: false, save: 'local' });

    folderView.slice.items[1].setRead(true);
  });
  do_assertReadStates([false, true, false, true, false, true, false, true]);

  T.group('single redundant setRead(false)');
  T.action('items[0].setRead(false)', function() {
    testAccount.expect_runOp(
      'modtags',
      { local: true, server: false, save: 'local' });

    folderView.slice.items[0].setRead(false);
  });
  do_assertReadStates([false, true, false, true, false, true, false, true]);

  T.group('semi-redundant batch setRead(true)');
  T.action('items[0:3].setRead(true)', function() {
    testAccount.expect_runOp(
      'modtags',
      { local: true, server: true, save: 'local' });

    testAccount.MailAPI.markMessagesRead(
      folderView.slice.items.slice(0, 4), true);
  });
  do_assertReadStates([true, true, true, true, false, true, false, true]);

  T.group('semi-redundant batch setRead(false)');
  T.action('items[0:3].setRead(true)', function() {
    testAccount.expect_runOp(
      'modtags',
      { local: true, server: true, save: 'local' });

    testAccount.MailAPI.markMessagesRead(
      folderView.slice.items.slice(4, 8), false);
  });
  do_assertReadStates([true, true, true, true, false, false, false, false]);

  T.group('cleanup');
  testUniverse.do_saveState();
});

/**
 * Create a source folder and a target folder with some messages in the source
 * folder.
 */
commonCase('move/trash messages', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eAccount = TEST_PARAMS.type === 'imap' ? testAccount.eImapAccount :
                                               testAccount.eAccount,
      eSync = T.lazyLogger('sync');

  function do_ensureFrontEndUpdatesReceived() {
    T.action('(wait for ping roundtrip to ensure front-end is up-to-date',
             eSync, ')', function() {
      eSync.expect('ping');
      testAccount.MailAPI.ping(function() {
        eSync.log('ping');
      });
    });
  }

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
  var trashFolder = testAccount.do_useExistingFolderWithType('trash', '');

  var sourceView = testAccount.do_openFolderView(
    'sourceView', sourceFolder,
    { count: 5, full: 5, flags: 0, changed: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  var targetView = testAccount.do_openFolderView(
    'targetView', targetFolder,
    { count: 0, full: 0, flags: 0, changed: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  // open the trash but don't care what's in there, we just care about deltas
  var trashView = testAccount.do_openFolderView(
    'trashView', trashFolder, null, null,
    { syncedToDawnOfTime: 'ignore' });

  T.check('initial unread counts', eSync, function() {
    // All 5 messages in source are unread, and there are none in target.
    testAccount.expect_unread('Before Move and Trash Unread Count',
      sourceFolder, eSync, 5);
    testAccount.expect_unread('Target Folder Before Unread',
      targetFolder, eSync, 0);
  });
  T.group('offline manipulation; released to server');

  var undoMoveBlind = null, undoMoveVisible = null, undoDelete = null;

  testUniverse.do_pretendToBeOffline(true);
  T.action('move/trash messages',
           testAccount, eAccount, eSync, function() {
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
  do_ensureFrontEndUpdatesReceived();
  T.check('verify unread counts after local ops have run', eSync, function() {
    // Starting with 5 unread messages, we move 2 messages out of the source
    // folder and delete 1, leaving us with 2.
    testAccount.expect_unread('After Move and Trash Unread Count',
      sourceFolder, eSync, 2);
    // And we moved one of those unread to the target folder.
    testAccount.expect_unread('Target Folder After Unread',
      targetFolder, eSync, 1);
  });
  T.action('go online, see changes happen for', eAccount,
           eSync, function() {
    var save = TEST_PARAMS.type !== 'activesync' ? false : 'server';
    testAccount.expect_runOp(
      'move',
      { local: false, server: true, save: save, conn: true });
    testAccount.expect_runOp(
      'move',
      { local: false, server: true, save: save });
    testAccount.expect_runOp(
      'delete',
      { local: false, server: true, save: save });
    eSync.expect('ops-done');
    // And the online operations running should not affect our counts.
    eSync.expect('Move and Trash Unread Count Still',  2);
    eSync.expect('Target Folder Unread Count Still',  1);
    testUniverse.pretendToBeOffline(false);
    testUniverse.universe.waitForAccountOps(
      testUniverse.universe.accounts[0],
      function() {
        eSync.log('ops-done');
        var unread = testUniverse.universe
          .getFolderStorageForFolderId(sourceFolder.id)
          .folderMeta.unreadCount;
        eSync.log('Move and Trash Unread Count Still', unread);
        var targetUnread = testUniverse.universe
          .getFolderStorageForFolderId(targetFolder.id)
          .folderMeta.unreadCount;
        eSync.log('Target Folder Unread Count Still', targetUnread);
      });
  });
  // Make sure we have the expected number of messages in the original folder.
  testAccount.do_refreshFolderView(
    sourceView,
    { count: 2, full: 0, flags: 2, changed: 0, deleted: 0 },
    // note: the empty changes assertion
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false });
  // Make sure we have the expected number of messages in the target folder.
  testAccount.do_refreshFolderView(
    targetView,
    { count: 1, full: 0, flags: 1, changed: 0, deleted: 0 },
    // note: the empty changes assertion
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  // Make sure we have the expected number of messages in the trash folder.
  testAccount.do_refreshFolderView(
    trashView,
    { count: 1, full: 0, flags: 1, changed: 0, deleted: 0 },
    // note: the empty changes assertion
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false });

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
    var save = TEST_PARAMS.type !== 'activesync' ? false : 'server';
    testAccount.expect_runOp(
      'delete',
      { local: false, server: true, save: save });
    eSync.expect('ops-done');

    testUniverse.pretendToBeOffline(false);
    testUniverse.universe.waitForAccountOps(
      testUniverse.universe.accounts[0],
      function() {
        eSync.log('ops-done');
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
    eSync.expect('ops-done');

    testUniverse.pretendToBeOffline(false);
    testUniverse.universe.waitForAccountOps(
      testUniverse.universe.accounts[0],
      function() {
        eSync.log('ops-done');
      });
  });
  // Refresh the folder to make sure the current state of the target folder
  // matches our expectation.  This will fail if the flags on the message are
  // not what they are locally.
  testAccount.do_refreshFolderView(
    targetView,
    { count: 2, full: 0, flags: 2, changed: 0, deleted: 0 },
    // note: the empty changes assertion
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  // And this is an extra sanity check on that delta-check.
  T.check(eSync, 'moved message is starred', function() {
    eSync.expect('moved message subject',
                 moveStarMailHeader.subject);
    eSync.expect('starred',  true);

    var actualHeader = targetView.slice.items[0];
    eSync.log('moved message subject', actualHeader.subject);
    eSync.log('starred', actualHeader.isStarred);
  });
  // Make sure we have the expected number of messages in the original folder.
  testAccount.do_refreshFolderView(
    sourceView,
    { count: 1, full: 0, flags: 1, changed: 0, deleted: 0 },
    // note: the empty changes assertion
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false });
});

/**
 * Create a source folder and a target folder with some messages in the source
 * folder, and then move them around in batches.
 */
commonCase('batch move/trash messages', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A',
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
  var trashFolder = testAccount.do_useExistingFolderWithType('trash', '');

  var sourceView = testAccount.do_openFolderView(
    'sourceView', sourceFolder,
    { count: 10, full: 10, flags: 0, changed: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  var targetView = testAccount.do_openFolderView(
    'targetView', targetFolder,
    { count: 0, full: 0, flags: 0, changed: 0, deleted: 0,
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

    undoMoveBlind = testUniverse.MailAPI.moveMessages(
                      toMoveBlind, blindTargetFolder.mailFolder);
    undoMoveVisible = testUniverse.MailAPI.moveMessages(
                        toMoveVisible, targetFolder.mailFolder);
    undoDelete = testUniverse.MailAPI.deleteMessages(toDelete);
  });

  T.action('go online, see changes happen for', eAccount,
           eSync, function() {
    var save = TEST_PARAMS.type !== 'activesync' ? false : 'server';
    testAccount.expect_runOp(
      'move',
      { local: false, server: true, save: save, conn: true });
    testAccount.expect_runOp(
      'move',
      { local: false, server: true, save: save });
    testAccount.expect_runOp(
      'delete',
      { local: false, server: true, save: save });
    eSync.expect('ops-done');

    testUniverse.pretendToBeOffline(false);
    testUniverse.universe.waitForAccountOps(
      testUniverse.universe.accounts[0],
      function() {
        eSync.log('ops-done');
      });
  });
  // Make sure we have the expected number of messages in the original folder.
  testAccount.do_refreshFolderView(
    sourceView,
    { count: 4, full: 0, flags: 4, changed: 0, deleted: 0 },
    // note: the empty changes assertion
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false });
  // Make sure we have the expected number of messages in the target folder.
  testAccount.do_refreshFolderView(
    targetView,
    { count: 2, full: 0, flags: 2, changed: 0, deleted: 0 },
    // note: the empty changes assertion
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  // Make sure we have the expected number of messages in the trash folder.
  testAccount.do_refreshFolderView(
    trashView,
    { count: 2, full: 0, flags: 2, changed: 0, deleted: 0 },
    // note: the empty changes assertion
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false });

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
    testUniverse.MailAPI.deleteMessages(toDelete);
  });
  T.action('go online, see changes happen for', eAccount, eSync, function() {
    var save = TEST_PARAMS.type !== 'activesync' ? false : 'server';
    testAccount.expect_runOp(
      'delete',
      { local: false, server: true, save: save });
    eSync.expect('ops-done');

    testUniverse.pretendToBeOffline(false);
    testUniverse.universe.waitForAccountOps(
      testUniverse.universe.accounts[0], function() {
        eSync.log('ops-done');
      });
  });
});

/**
 * (Local only) drafts can be deleted, but they don't go to the trash, they just
 * get nuked.  Drafts *cannot* be moved.
 */
commonCase('trash drafts', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eAccount = TEST_PARAMS.type === 'imap' ? testAccount.eImapAccount :
                                               testAccount.eAccount,
      eLazy = T.lazyLogger('check');

  var trashFolder = testAccount.do_useExistingFolderWithType('trash', ''),
      trashView = testAccount.do_openFolderView(
        'trashView', trashFolder, null, null,
        { syncedToDawnOfTime: 'ignore' }),

      localDraftsFolder = testAccount.do_useExistingFolderWithType(
        'localdrafts', ''),
      localDraftsView = testAccount.do_openFolderView(
        'localdrafts', localDraftsFolder, null, null,
        { nonet: true }),
      composer;

  T.group('create draft message');
  T.action('begin composition', eLazy, function() {
    eLazy.expect('compose setup completed');
    composer = testUniverse.MailAPI.beginMessageComposition(
      null, testUniverse.allFoldersSlice.getFirstFolderWithType('inbox'), null,
      eLazy.log.bind(eLazy, 'compose setup completed'));
  });

  T.action(testAccount, 'compose, save', eLazy, function() {
    testAccount.expect_runOp(
      'saveDraft',
      { local: true, server: false, save: true });
    eLazy.expect('saved');

    composer.to.push({ name: 'Myself', address: TEST_PARAMS.emailAddress });
    composer.subject = 'Midnight City';
    composer.body.text = 'We own the sky.';

    composer.saveDraft(function() {
      eLazy.log('saved');
    });
    composer.die();
    composer = null;
  });

  // This is a dalek reference doctor who, you see.
  T.group('exterminate! exterminate!');
  // This was going to be a homestar runner 'balete' reference, but would have
  // proved confusing.
  T.action(testAccount, 'delete', function() {
    var save = TEST_PARAMS.type !== 'activesync' ? true : 'both';
    testAccount.expect_runOp(
      'delete',
      { local: true, server: true, save: save });

    var header = localDraftsView.slice.items[0];
    header.deleteMessage();
  });
  T.check('in neither folder', eLazy, function() {
    eLazy.expect('trash count',  0);
    eLazy.expect('draft count',  0);

    eLazy.log('trash count', trashView.slice.items.length);
    eLazy.log('draft count', localDraftsView.slice.items.length);
  });

  T.group('cleanup');
});

return allTests;

}); // end define

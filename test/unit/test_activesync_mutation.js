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
 **/

load('resources/loggest_test_framework.js');
const $wbxml = require('wbxml');
const $ascp = require('activesync/codepages');

var TD = $tc.defineTestsFor(
  { id: 'test_activesync_mutation' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('mutate flags', function(T) {
  const FilterType = $ascp.AirSync.Enums.FilterType;

  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A', { universe: testUniverse }),
      eSync = T.lazyLogger('sync'),
      numMessages = 4;

  var testFolder = testAccount.do_createTestFolder(
    'test_mutation_flags',
    { count: numMessages, age_incr: { days: 1 } });
  var folderView = testAccount.do_openFolderView(
    'folderView', testFolder,
    { count: numMessages, full: numMessages, flags: 0, deleted: 0,
      filterType: FilterType.NoFilter },
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
        toStarAndMarkRead = headers[3];

    applyManips = function applyManips() {
      undoOps = [];

      undoOps.push(toMarkRead.setRead(true));
      undoOps.push(toStar.setStarred(true));
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
    { count: numMessages, full: 0, flags: 0, deleted: 0 },
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
      undoHeaderExps.changes.length);
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
    { count: numMessages, full: 0, flags: 0, deleted: 0 },
    { changes: [], deletions: [] },
    { top: true, bottom: true, grow: false });

  T.group('cleanup');
  testAccount.do_closeFolderView(folderView);
});

function run_test() {
  runMyTests(15);
}

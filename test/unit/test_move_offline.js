define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var $mailapi = require('mailapi');

/**
 * Ensure that partially-completed offline moves don't break the sync
 * of the target folder if we attempt to refresh the target folder
 * before the move completes (bug 839273).
 *
 * Test the following scenario:
 *
 * 1. Go offline and move a message from one folder to another.
 *    Because we're offline, only the local side will complete.
 *
 * 2. Force the job system to temporarily stop running jobs, to
 *    simulate a backlog of queued jobs, causing the server side of
 *    the move to be delayed until AFTER we try to sync the target
 *    folder.
 *
 * 3. Star a message in the target folder *on the server*.
 *
 * 4. Go online and view the target folder's contents. We should see
 *    the newly-starred message, indicating that the sync completed
 *    successfully, even though we left a not-yet-completed "move"
 *    message in the target folder.
 */
return new LegacyGelamTest('partially-completed move does not break sync',
                           function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A',
                            { universe: testUniverse }),
      eSync = T.lazyLogger('check');

  var sourceFolder = testAccount.do_createTestFolder(
    'test_move_source',
    { count: 5, age: { days: 1 }, age_incr: { days: 1 } });

  var targetFolder = testAccount.do_createTestFolder(
    'test_move_target',
    { count: 2, age: { days: 1 }, age_incr: { days: 1 } });

  var sourceView = testAccount.do_openFolderView(
    'sourceView', sourceFolder,
    { count: 5, full: 5, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  var targetView = testAccount.do_openFolderView(
    'targetView', targetFolder,
    { count: 2, full: 2, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  testUniverse.do_pretendToBeOffline(true);

  var FAKE_SERVER_OP = { serverStatus: 'doing' };

  T.action('try the move job op', testAccount, function() {
    var messageToMove = sourceView.slice.items[1];

    // The local op will complete; the server won't since we're offline.
    testAccount.expect_runOp(
      'move', { local: true, server: false, save: true });

    var eFS = T.actor('FolderStorage');
    // The local job will succeed and it will release its mutexes without having
    // experienced any errors.
    eFS.expect('mailslice:mutex-released',
               { folderId: sourceFolder.id, err: null });
    eFS.expect('mailslice:mutex-released',
               { folderId: targetFolder.id, err: null });

    // Force the job system to appear backlogged, by inserting a fake
    // operation at the beginning. This op will block the server queue
    // from completing the move.
    testUniverse.universe._queueAccountOp(
      testAccount.account, FAKE_SERVER_OP);

    // Move the message locally.
    testUniverse.MailAPI.moveMessages(
      [messageToMove], targetFolder.mailFolder);

    // Now, flag the first message in the target folder.
    testAccount.modifyMessageFlagsOnServerButNotLocally(
      targetView, [0], ['\\Flagged'], null);
  });

  testAccount.do_closeFolderView(sourceView);
  testAccount.do_closeFolderView(targetView);

  // Go back online.
  testUniverse.do_pretendToBeOffline(false);

  // Open the folder again and sync; if all is well, we should see the
  // starred message, indicating that the sync succesfully fetched
  // updates.

  // (I would have liked to just set proper 'count'/'flags'
  // expectations with do_viewFolder, but the locally-moved message
  // breaks th_main's localMessages bookkeeping. Otherwise, we could
  // have just run a sync expecting the proper changes.)
  var targetView2 = testAccount.do_openFolderView(
    'targetView2', targetFolder,
    null,
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.action("verify folder contents", eSync, function() {
    var starredMsg = targetView2.slice.items[0];
    eSync.expect("first message is starred",  true);
    eSync.log("first message is starred", starredMsg.isStarred);
  });

  testAccount.do_closeFolderView(targetView2);
});


}); // end define

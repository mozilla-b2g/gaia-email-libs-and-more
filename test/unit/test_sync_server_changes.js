/**
 * Test our sync mechanism's ability to update already-synchronized messages'
 * states based on changes that happen on the server somehow.  (Probably via
 * a webmail UI or other client.)
 *
 * This file is not run for POP3 which of course lacks such niceties.
 */

define(['rdcommon/testcontext', './resources/th_main',
        './resources/messageGenerator', 'exports'],
       function($tc, $th_main, $msggen, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_sync_server_changes' }, null, [$th_main.TESTHELPER], ['app']);

TD.commonCase('detect server changes', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A', { universe: testUniverse }),
      eSync = T.lazyLogger('sync');

  var testFolder = testAccount.do_createTestFolder(
    'test_sync_server_changes', // (insert one more than we want to find)
    { count: 9, age: { days: 1 }, age_incr: { days: 1 }, age_incr_every: 2 });
  var manipView = testAccount.do_openFolderView(
    'syncs', testFolder,
    [{ count: 9, full: 9, flags: 0, deleted: 0,
       filterType: 'none' }],
    { top: true, bottom: true, grow: false, newCount: null },
    { syncedToDawnOfTime: true });

  T.group('sync detects additions/modifications/deletions with fresh view');
  // Change existing messages and delete some existing ones (3, so => 6).
  T.action('mutate', testFolder, function() {
    testAccount.modifyMessageFlagsOnServerButNotLocally(
      manipView, [3], ['\\Seen'], null);
    testAccount.modifyMessageFlagsOnServerButNotLocally(
      manipView, [4], ['\\Flagged'], null);
    testAccount.deleteMessagesOnServerButNotLocally(
      manipView, [1, 2, 8]);
  });
  testAccount.do_closeFolderView(manipView);

  // Add some more messages to the folder. ( => 11 )
  testAccount.do_addMessagesToFolder(
    testFolder,
    { count: 5, age: { days: 2 }, age_incr: { days: 1 }, age_incr_every: 2 });
  // - open view, checking refresh, and _leave it open_ for the next group
  var checkView = testAccount.do_openFolderView(
    'check', testFolder,
    [{ count: 11, full: 5, flags: 6, changed: 2, deleted: 3 }],
    // these messages are all older than the newest message, none are 'new'
    { top: true, bottom: true, grow: false, newCount: 0 });

  /**
   * Perform some manipulations with the view still open, then trigger a refresh
   * and make sure the view updates correctly.
   */
  T.group('sync refresh detects mutations and updates in-place with open view');
  var expectedRefreshChanges = {
    changes: null,
    deletions: null,
  };
  T.action('mutate', testFolder, function() {
    expectedRefreshChanges.deletions =
      testAccount.deleteMessagesOnServerButNotLocally(checkView, [0, 8]);
    var read = testAccount.modifyMessageFlagsOnServerButNotLocally(
                 checkView, [9], ['\\Seen'], null)[0];
    var starred = testAccount.modifyMessageFlagsOnServerButNotLocally(
                    checkView, [10], ['\\Flagged'], null)[0];
    expectedRefreshChanges.changes = [
      [read, 'isRead', true],
      [starred, 'isStarred', true],
    ];
  });
  testAccount.do_refreshFolderView(
    checkView,
    // Our expectations happen in a single go here because the refresh covers
    // the entire date range in question.
    { count: 9, full: 0, flags: 9, changed: 2, deleted: 2 },
    expectedRefreshChanges,
    { top: true, bottom: true, grow: false, newCount: 0 });

  T.group('cleanup');
  testAccount.do_closeFolderView(checkView);
});

}); // end define

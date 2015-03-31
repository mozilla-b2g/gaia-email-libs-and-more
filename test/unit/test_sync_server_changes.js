/**
 * Test our sync mechanism's ability to update already-synchronized messages'
 * states based on changes that happen on the server somehow.  (Probably via
 * a webmail UI or other client.)
 *
 * This file is not run for POP3 which of course lacks such niceties.
 */

define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');

return new LegacyGelamTest('detect server changes', function(T) {
  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A', { universe: testUniverse }),
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
  T.action('mutate', testFolder, eSync, function() {
    // All 9 messages are new and accordingly unread...
    testAccount.expect_unread('Unread Before Server Changes', testFolder,
                              eSync, 9);
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
  T.check('check unread count', eSync, function() {
    // We had 9 unread, we marked 1 read, then deleted 3 others, then added
    // 5 more.  So 9 - 1 - 3 + 5 = 10.
    testAccount.expect_unread('Unread After 1st Server Changes', testFolder,
                              eSync, 10);
  });

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


  T.group('fail to get the message body for a deleted message');
  T.action(eSync, 'request deleted message body from',
           testFolder.storageActor, function() {
    // We had 10 unread, then we deleted another 2 and marked another 1 read, so
    // 10 - 2 - 1 = 7.
    testAccount.expect_unread('Unread After Server Changes', testFolder,
                              eSync, 7);
    eSync.expect('bodyInfo',  null);
    testFolder.storageActor.expect('bodyNotFound');
    var deletedHeader = expectedRefreshChanges.deletions[0];
    deletedHeader.getBody(function(bodyInfo) {
      eSync.log('bodyInfo', bodyInfo);
      // it's null so we don't call bodyInfo.die(), but if it wasn't...!
    });
  });

  T.group('cleanup');
  testAccount.do_closeFolderView(checkView);
});

}); // end define

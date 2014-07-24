

define(['rdcommon/testcontext', './resources/th_main',
        'activesync/codepages', 'activesync/codepages/AirSync', 'exports'],
       function($tc, $th_main, $ascp, $airsync, exports) {
const FilterType = $airsync.Enums.FilterType;
var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_storage_upgrade' }, null,
  [$th_main.TESTHELPER], ['app']);



TD.commonCase('with version 0, upgrade is triggered', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse }),
      eSync = T.lazyLogger('sync');

  var numMessages = 7;


  var numFolders, numAdds = 0, numDeletes = 0;
    var testFolder = testAccount.do_createTestFolder(
    'test_folder_upgrade',
    { count: numMessages, age_incr: { days: 1 } });
  var folderView = testAccount.do_openFolderView(
    'folderView', testFolder,
    { count: numMessages, full: numMessages, flags: 0, changed: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.group('add messages and upgrade');
  T.check('initial unread counts', eSync, function() {
    // We added 7 messages and they all start out unread.
    testAccount.expect_unread('Before Upgrade', testFolder.id,
      eSync, 7);
  });



  T.action('run upgrade', eSync, function(T) {
    var storage = testAccount.universe
      .getFolderStorageForFolderId(testFolder.id);
    storage.folderMeta.version = 0;
    storage.folderMeta.unreadCount = 0;
    testAccount.expect_runOp('upgradeDB',
      { local: true, server: false, save: false });
    console.log(testAccount.id);
    storage.upgradeIfNeeded();
    eSync.expect_event('ops-clear');
    testUniverse.universe.waitForAccountOps(
      testUniverse.universe.accounts[0],
      function() {
        eSync.event('ops-clear');
        testAccount.expect_unread('After upgrade', testFolder.id,
      eSync, 7);
      });
  });

  T.group('cleanup');
});




});
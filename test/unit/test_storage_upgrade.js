define(function(require, exports) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var $airsync = require('activesync/codepages/AirSync');

const FilterType = $airsync.Enums.FilterType;

return new LegacyGelamTest('with version 0, upgrade is triggered', function(T) {
  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A',
                            { universe: testUniverse }),
      eSync = T.lazyLogger('sync');

  var numMessages = 7;


  var numFolders, numAdds = 0, numDeletes = 0;
    var testFolder = testAccount.do_createTestFolder(
    'test_folder_upgrade',
    { count: numMessages, age_incr: { days: 1 } });
  // Cause the folder to be synced, but don't save it off in a view.  By closing
  // it we ensure that all blocks will be flushed so the upgrade process will
  // need to asynchronously wait for a database load and thereby ensure the
  // upgrade process won't complete until a future turn of the event loop and so
  // we can make sure it has't prematurely updated the folder version.
  testAccount.do_viewFolder(
    'syncs', testFolder,
    { count: numMessages, full: numMessages, flags: 0, changed: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.group('add messages and upgrade');
  T.check('initial unread counts', eSync, function() {
    // We added 7 messages and they all start out unread.
    testAccount.expect_unread('Normal up-to-date behaviour',
                              testFolder, eSync, 7);
  });

  T.action('clobber database to pre-version 2 state', eSync, function() {
    var storage = testAccount.universe
      .getFolderStorageForFolderId(testFolder.id);
    storage.folderMeta.version = 0;
    storage.folderMeta.unreadCount = 0;

    testAccount.universe.__notifyModifiedFolder(testAccount.account,
                                                storage.folderMeta);
    // wait for a front-end/back-end roundtrip so the folder update notification
    // definitely has been processed.
    eSync.expect('roundtrip');
    testAccount.MailAPI.ping(eSync.log.bind(eSync, 'roundtrip'));
  });

  T.action('run upgrade', eSync, function(T) {
    testAccount.expect_unread('After clobbering, before upgrade',
                              testFolder, eSync, 0);

    var storage = testAccount.universe
      .getFolderStorageForFolderId(testFolder.id);
    eSync.expect('version after scheduling but before job completes', 0);
    testAccount.expect_runOp('upgradeDB',
      { local: true, server: false, save: 'local' });
    testAccount.account.upgradeFolderStoragesIfNeeded();
    eSync.log('version after scheduling but before job completes',
                     storage.folderMeta.version);
  });

  T.check('unread counts', eSync, function() {
    testAccount.expect_unread('After upgrade', testFolder, eSync, 7);
  });

  T.group('cleanup');
});

});

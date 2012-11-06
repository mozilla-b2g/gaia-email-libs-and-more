/**
 * Test our ActiveSync sync logic under non-pathological conditions.  Currently,
 * this just tests that we can create an account successfully.  More tests
 * coming soon!
 **/

load('resources/loggest_test_framework.js');
const $wbxml = require('wbxml');
const $ascp = require('activesync/codepages');
load('resources/messageGenerator.js');
load('../activesync_server.js');

var TD = $tc.defineTestsFor(
  { id: 'test_activesync_general' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('folder sync', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testServer = T.actor('testActiveSyncServer', 'S',
                           { universe: testUniverse }),
      testAccount = T.actor('testActiveSyncAccount', 'A',
                            { universe: testUniverse, server: testServer }),
      eSync = T.lazyLogger('sync');

  T.action(eSync, 'check folder list', testAccount, function() {
    eSync.expect_namedValue('inbox', {
      syncKey: '0',
      hasServerId: true
    });

    var folder = testAccount.account.getFirstFolderWithType('inbox');
    eSync.namedValue('inbox', {
      syncKey: folder.syncKey,
      hasServerId: folder.serverId !== null
    });
  });

  T.action(eSync, 'add folder and resync', testServer, testAccount.eAccount,
           function() {
    testAccount.eAccount.expect_runOp_begin('do', 'syncFolderList');
    testAccount.eAccount.expect_runOp_end('do', 'syncFolderList');
    testAccount.expect_saveState();

    eSync.expect_namedValue('folder', {
      name: 'Test',
      type: 'normal'
    });

    testServer.server.addFolder('Test', $ascp.FolderHierarchy.Enums.Type.Mail);
    MailUniverse.syncFolderList(testAccount.account, function() {
      var folder;
      for (var i = 0; i < testAccount.account.folders.length; i++) {
        if (testAccount.account.folders[i].name === 'Test')
          folder = testAccount.account.folders[i];
      }

      eSync.namedValue('folder', folder && {
        name: folder.name,
        type: folder.type
      });
    });
  });

  T.group('cleanup');
});

function run_test() {
  runMyTests(5);
}

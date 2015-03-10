/**
 * Make sure POP3 only opens a connection for the inbox.
 **/

define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');

return new LegacyGelamTest('connection use', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U');
  var testAccount = T.actor('TestAccount', 'A', { universe: testUniverse });
  var eSync = T.lazyLogger('sync');

  var trashFolder = testAccount.do_useExistingFolderWithType('trash', '');
  var inboxFolder = testAccount.do_useExistingFolderWithType('inbox', '');

  T.action('close existing connection', function() {
    testAccount.folderAccount._conn.close();
  });

  // Trash must not create a connection.
  testAccount.do_openFolderView(
    'opens', trashFolder,
    { count: 0, full: 0 },
    { top: true, bottom: true, grow: false, newCount: null },
    { nonet: true });

  // Inbox must create a connection.
  testAccount.do_openFolderView(
    'opens', inboxFolder,
    { count: 0, full: 0 },
    { top: true, bottom: true, grow: false, newCount: null },
    { syncedToDawnOfTime: true });

  T.group('cleanup');
});

}); // end define

/**
 * Make sure POP3 only opens a connection for the inbox.
 **/

define(['rdcommon/testcontext', './resources/th_main',
        'wbxml', 'activesync/codepages',
        'exports'],
       function($tc, $th_main, $wbxml, $ascp, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_pop3_connection_use' }, null,
  [$th_main.TESTHELPER], ['app']);

TD.commonCase('connection use', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U');
  var testAccount = T.actor('testAccount', 'A', { universe: testUniverse });
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

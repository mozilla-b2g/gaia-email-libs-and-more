/**
 * Test our processing of HTML messages and messages with attachments from
 * ActiveSync.
 **/

load('resources/loggest_test_framework.js');
const $wbxml = require('wbxml');
const $ascp = require('activesync/codepages');
load('resources/messageGenerator.js');
load('../activesync_server.js');

var TD = $tc.defineTestsFor(
  { id: 'test_activesync_html' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('folder sync', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testServer = T.actor('testActiveSyncServer', 'S',
                           { universe: testUniverse }),
      testAccount = T.actor('testActiveSyncAccount', 'A',
                            { universe: testUniverse, server: testServer }),
      eCheck = T.lazyLogger('messageCheck');

  var fullSyncFolder = testAccount.do_createTestFolder(
    'test_initial_full_sync',
    { count: 0 });

  var bstrTrivialHtml =
        '<html><head></head><body>I am HTML! Woo!</body></html>',
      bstrSanitizedTrivialHtml =
        'I am HTML! Woo!',
      bpartTrivialHtml = new SyntheticPartLeaf(
        bstrTrivialHtml, {contentType: 'text/html'});

  var testMessages = [
    {
      name: 'trivial html',
      bodyPart: bpartTrivialHtml,
      checkBody: bstrSanitizedTrivialHtml,
    },
  ];

  for (var i = 0; i < testMessages.length; i++) {
    var msgDef = testMessages[i];
    msgDef.age = { days: 1, hours: i };
    testAccount.do_addMessageToFolder(fullSyncFolder, msgDef);
  }

  var folderView = testAccount.do_openFolderView(
    'syncs', fullSyncFolder,
    { count: 1, full: 1, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false }
  );
  // -- check each message in its own step
  testMessages.forEach(function checkMessage(msgDef, iMsg) {
    T.check(eCheck, msgDef.name, function() {
      eCheck.expect_namedValue('body', msgDef.checkBody);
      var header = folderView.slice.items[0];
      header.getBody(function(body) {
        var bodyValue;
        if (!body.bodyReps.length)
          bodyValue = '';
        else if (body.bodyReps[0] === 'plain')
          bodyValue = body.bodyReps[1][1] || '';
        else if (body.bodyReps[0] === 'html')
          bodyValue = body.bodyReps[1];
        eCheck.namedValue('body', bodyValue);
      });
    });
  });

  T.group('cleanup');
  testAccount.do_closeFolderView(folderView);
});

function run_test() {
  runMyTests(5);
}

define(['rdcommon/testcontext', './resources/th_main', 'exports'],
       function($tc, $th_imap, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_body_modified_attachments' },
  null,
  [$th_imap.TESTHELPER], ['app']
);

TD.commonCase('body properly updates when attachments change', function(T, RT) {
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A', { universe: testUniverse });

  var eLazy = T.lazyLogger('misc');
  // We want just one message in the inbox; IMAP already adds one for
  // tests so that we can detect timezones, so only add one for other
  // account types.
  var messageCount = (testAccount.type === 'imap' ? 0 : 1);

  // Set POP3 to not retrieve any of the message when fetching
  // headers. Otherwise it might have already finished downloading
  // short messages, which would make the assertions below
  // inconsistent between prototols.
  testUniverse.do_adjustSyncValues({
    POP3_SNIPPET_SIZE_GOAL: 0
  });

  // Use the inbox, so that POP3 will actually run its sync logic.
  var testFolder = testAccount.do_useExistingFolderWithType('inbox', '');
  if (messageCount > 0) {
    testAccount.do_addMessagesToFolder(testFolder, {
      count: messageCount,
      attachments: [{
        filename: 'stuff.png',
        contentType: 'image/png',
        encoding: 'base64',
        body: 'YWJj\n'
      },{
        filename: 'stuff.png',
        contentType: 'image/png',
        encoding: 'base64',
        body: 'YWJj\n'
      }],
    });
  }

  var testView = testAccount.do_openFolderView(
    'syncs', testFolder, null, null, { syncedToDawnOfTime: 'ignore' });

  T.action('body updates attachment', eLazy, function() {
    var header = testView.slice.items[0];

    // 1. We fetch the body, instructing the reps to download
    //    asynchronously. Before the body reps have a chance to
    //    download, we set an "onchange" handler.
    //
    // 2. The initial body returned before we download reps will
    //    expect _one_ attachment, because the mime type of the
    //    message is multipart.
    //
    // 3. After the body's "onchange" handler fires, we should see
    //    both attachments listed on the MailBody object. Before this
    //    patch, the MailBody object did not update to include the
    //    correct number of attachments.

    eLazy.expect_namedValue('initial attachments length', 1);
    eLazy.expect_namedValue('attachments length', 2);
    header.getBody({ downloadBodyReps: true }, function (body) {
      eLazy.namedValue('initial attachments length', body.attachments.length);
      body.onchange = function() {
        eLazy.namedValue('attachments length', body.attachments.length);
      }
    });
  }).timeoutMS = 5000;

});

}); // end define

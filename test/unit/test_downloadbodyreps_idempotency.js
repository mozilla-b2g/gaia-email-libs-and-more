define(['rdcommon/testcontext', './resources/th_main', 'exports'],
       function($tc, $th_imap, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_downloadbodyreps_idempotency' },
  null,
  [$th_imap.TESTHELPER], ['app']
);

TD.commonCase('fetch only snippets', function(T, RT) {
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A', { universe: testUniverse });

  // Create a folder to test on
  var eLazy = T.lazyLogger('misc');
  var folderName = 'test_downloadbodyreps_idempotency';
  var messageCount = 3;

  // Set POP3 to not retrieve any of the message when fetching
  // headers. Otherwise it might have already finished downloading
  // short messages, which would make the assertions below
  // inconsistent between prototols.
  testUniverse.do_adjustSyncValues({
    POP3_SNIPPET_SIZE_GOAL: 0
  });

  // Use the inbox, so that POP3 will actually run its sync logic.
  var testFolder = testAccount.do_useExistingFolderWithType('inbox', '');
  testAccount.do_addMessagesToFolder(testFolder, { count: messageCount });
  var testView = testAccount.do_openFolderView(
    'syncs', testFolder, null, null, { syncedToDawnOfTime: 'ignore' });

  // When requesting bodyReps multiple times, we should only see one
  // set of "onchange" notifications -- after we actually download and
  // change the body. In other words, we enforce an idempotency
  // guarantee that the frontend doesn't have to worry about
  // spurious/redundant body "onchange" notifications.
  T.action('request full body after snippets', eLazy, function() {
    eLazy.expectUseSetMatching();

    testView.slice.items.forEach(function(header, idx) {
      var whichCall = 0;

      // The first call should receive a modified onchange event.
      eLazy.expect_value('modified-' + idx);
      // Then we called getBody twice, so we should see two more
      // "done" events _without_ seeing more change events.
      eLazy.expect_value('done-' + idx);
      eLazy.expect_value('done-' + idx);

      function gotBody(body) {
        whichCall++;
        if (whichCall === 1) {
          // Attach the handler for this body here; it should only be
          // called once even though we're calling getBody multiple
          // times.
          body.onchange = function() {
            eLazy.value('modified-' + idx);
          }
        } else {
          header.getBody({ withBodyReps: true }, function() {
            eLazy.value('done-' + idx);
          });
        }
      }

      // Fetch the body thrice; the first will generate onchange;
      // the other two should just indicate that we've finished.
      header.getBody({ downloadBodyReps: true }, gotBody);
      header.getBody({ downloadBodyReps: true }, gotBody);
      header.getBody({ downloadBodyReps: true }, gotBody);
    });
  });

//  testAccount.do_closeFolderView(testView);

});

}); // end define

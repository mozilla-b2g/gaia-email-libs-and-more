define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');

return new LegacyGelamTest('fetch only snippets', function(T, RT) {
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A', { universe: testUniverse });

  // Create a folder to test on
  var eLazy = T.lazyLogger('misc');
  var folderName = 'test_downloadbodyreps_idempotency';
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
    testAccount.do_addMessagesToFolder(testFolder, { count: messageCount });
  }
  var testView = testAccount.do_openFolderView(
    'syncs', testFolder, null, null,
    { syncedToDawnOfTime: 'ignore', batches: 1 });

  // When requesting bodyReps multiple times, we should only see one
  // set of "onchange" notifications -- after we actually download and
  // change the body. In other words, we enforce an idempotency
  // guarantee that the frontend doesn't have to worry about
  // spurious/redundant body "onchange" notifications.
  T.action('request full body after snippets', eLazy, function() {
    // only the first job will actually download the bodies, the other
    // jobs will still happen but will turn into no-ops
    // this might need conn: true/etc.

    // We need three of these: Two for "downloadBodyReps" calls, and
    // one for the "withBodyReps" call. Only the first will actually
    // cause us to download and save the bodyReps.
    testAccount.expect_runOp('downloadBodyReps', {
      local: false,
      server: true,
      save: 'server'
    });
    // these will run the server operations but they will realize there is
    // nothing to do and so accordingly will not do connectiony things and
    // will accordingly also not need to save state.
    testAccount.expect_runOp('downloadBodyReps', {
      local: false, server: true, save: false, conn: false });
    testAccount.expect_runOp('downloadBodyReps', {
      local: false, server: true, save: false, conn: false });

    // there's only one message in the inbox
    var header = testView.slice.items[0];

    // The first call should receive a modified onchange event.
    eLazy.expect('modified');
    // Then we called getBody twice, so we should see two more
    // "done" events _without_ seeing more change events.
    eLazy.expect('done');

    // Fetch the body thrice; the first will generate onchange;
    // the other two should just indicate that we've finished.
    header.getBody({ downloadBodyReps: true }, function (body) {
      // Attach the handler for this body here; it should only be
      // called once even though we're calling getBody multiple
      // times.
      body.onchange = function() {
        eLazy.log('modified');
      }
    });

    header.getBody({ downloadBodyReps: true }, function(body) {
      // Use { withBodyReps: true } so that the 'done' event
      // happens after we see onchange.
      header.getBody({ withBodyReps: true }, function() {
        eLazy.log('done');
      });
    });
  });

});

}); // end define

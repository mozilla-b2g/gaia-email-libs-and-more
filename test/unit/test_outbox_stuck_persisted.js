/**
 * Test several scenarios related to sending messages, focusing on how
 * they interact with the outbox and localdrafts. This particular test
 * file assumes that there is coverage elsewhere (as in
 * `test_compose.js`) for message-specific edge cases like attachments,
 * MIME parsing, and other such stuff.
 */
define(['rdcommon/testcontext', './resources/th_main',
        './resources/th_devicestorage', './resources/messageGenerator',
        'util', 'accountcommon', 'exports'],
       function($tc, $th_imap, $th_devicestorage, $msggen,
                $util, $accountcommon, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_outbox_stuck_persisted' }, null,
  [$th_imap.TESTHELPER, $th_devicestorage.TESTHELPER], ['app']);

// We cannot use a static subject in case we run this test on a real
// server, which may have messages in folders already.
function makeRandomSubject() {
  return 'Composition: ' + Date.now() +  Math.random() * 100000;
}

// 2) Try to send two messages, both fail. Clean shutdown the
// universe. Start the universe back up. Have the automatic-ish "send
// everything in the inbox" flow trigger and everything get sent.
TD.commonCase('two get stuck, automated send everything sends them',
              function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U');
  var testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse });
  var eLazy = T.lazyLogger('misc');

  var subjects = [
    makeRandomSubject(),
    makeRandomSubject()
  ];

  var composer;
  var folders = {};
  var views = {};

  ['localdrafts', 'outbox'].forEach(function(type) {
    folders[type] = testAccount.do_useExistingFolderWithType(type, '');
    views[type] = testAccount.do_openFolderView(
      type, folders[type], null, null, {
        syncedToDawnOfTime: 'ignore',
        nonet: true //(['outbox', 'localdrafts'].indexOf(type) !== -1)
      });
  });

  // Send two messages. They both fail and get stuck in the outbox.

  T.check('Force send failure', function() {
    testAccount.testServer.toggleSendFailure(true);
  });

  subjects.forEach(function(subject, idx) {
    T.group('Send "' + subject + '"');
    testAccount.do_composeAndSendMessage(
      subject,
      // the second one will retry and will fail
      {
        success: false,
        existingRetryResults: idx ? ['failure'] : [],
        outboxView: views.outbox
      });

    // Verify that the messages appear in the outbox.
    testAccount.do_waitForMessage(views.outbox, subject, {
      expect: function() {
        RT.reportActiveActorThisStep(eLazy);
        eLazy.expect_namedValue('subject', subject);
      },
      withMessage: function(header) {
        eLazy.namedValue('subject', header.subject);
      }
    }).timeoutMS = TEST_PARAMS.slow ? 30000 : 5000;
  });

  T.check('Force send failure', function() {
    testAccount.testServer.toggleSendFailure(false);
  });

  T.group('shutdown the universe');
  // Shut down the first universe.
  for (var key in views) {
    testAccount.do_closeFolderView(views[key]);
  }
  testUniverse.do_saveState();
  testUniverse.do_shutdown();

  // BEGIN UNIVERSE 2
  T.group('BEGIN UNIVERSE 2');

  var testUniverse2 = T.actor('testUniverse', 'U', { old: testUniverse });
  var testAccount2 = T.actor('testAccount', 'A',
                             { universe: testUniverse2,
                               restored: true });

  var views2 = {};

  // Open up the folders we need
  ['localdrafts', 'outbox'].forEach(function(type) {
    views2[type] = testAccount2.do_openFolderView(
      type, testAccount2.do_useExistingFolderWithType(type, ''), null, null, {
        syncedToDawnOfTime: 'ignore',
        nonet: (['outbox', 'localdrafts'].indexOf(type) !== -1)
      });
  });

  T.action('Try to send all msgs online, should work', eLazy, function() {
    testAccount2.expect_sendOutboxMessages();
    testAccount2.expect_saveSentMessage(true);
    testAccount2.expect_sendOutboxMessages();
    testAccount2.expect_saveSentMessage(true);

    testUniverse2.universe.sendOutboxMessages(
      testUniverse2.universe.accounts[0]);

    eLazy.expect_event('ops-done');
    testUniverse2.universe.waitForAccountOps(
      testUniverse2.universe.accounts[0],
      function() {
        eLazy.event('ops-done');
      });
  });

  T.group('Expect the messages to be sent!');

  views2.sent = testAccount2.do_openFolderView(
    'sent', testAccount2.do_useExistingFolderWithType('sent', ''), null, null, {
      syncedToDawnOfTime: 'ignore',
    });

  // They should show up in the sent folder.
  subjects.forEach(function(subject) {
    testAccount2.do_waitForMessage(views2.sent, subject, {
      expect: function() {
        RT.reportActiveActorThisStep(eLazy);
        eLazy.expect_namedValue('subject', subject);
      },
      withMessage: function(header) {
        eLazy.namedValue('subject', header.subject);
      }
    }).timeoutMS = TEST_PARAMS.slow ? 30000 : 5000;
  });

  // Ensure there are no more outbox messages
  T.check('outbox messages deleted', eLazy, function() {
    eLazy.expect_namedValue('outbox count', 0);
    testAccount2.MailAPI.ping(function() {
      eLazy.namedValue('outbox count', views2.outbox.slice.items.length);
    });
  });

});

}); // end define

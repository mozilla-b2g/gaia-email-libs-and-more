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
  { id: 'test_outbox_stuck_retry' }, null,
  [$th_imap.TESTHELPER, $th_devicestorage.TESTHELPER], ['app']);

// We cannot use a static subject in case we run this test on a real
// server, which may have messages in folders already.
function makeRandomSubject() {
  return 'Composition: ' + Date.now() +  Math.random() * 100000;
}

// Send message, fail, gets stuck in outbox. Send second message,
// fail, gets stuck in outbox. Verify the messages appear in the
// outbox. Tell back-end we are editing the outbox/don't send stuff.
// Trigger an outbox send like we hit refresh in the UI. We do not try
// and send stuff. Say we're done editing the outbox. Tell the fake
// server to let the message get sent. Trigger sending from outbox,
// watch the two messages get sent.
TD.commonCase('send message, fail, gets stuck in outbox', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U', { realDate: true });
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
        nonet: (['outbox', 'localdrafts'].indexOf(type) !== -1)
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

    // Ensure there are no drafts (they should be in the outbox now)
    T.check('draft messages deleted', eLazy, function() {
      eLazy.expect_namedValue('draft count', 0);
      testAccount.MailAPI.ping(function() {
        eLazy.namedValue('draft count', views.localdrafts.slice.items.length);
      });
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

  T.check('Tell the outgoing server to accept messages again', function() {
    testAccount.testServer.toggleSendFailure(false);
  });


  T.group('Disable sending while editing');
  testUniverse.do_setOutboxSyncEnabled(false);

  T.check('Try to send while disabled', eLazy, function() {
    testUniverse.universe.sendOutboxMessages(testUniverse.universe.accounts[0]);

    eLazy.expect_event('ops-done');
    testUniverse.universe.waitForAccountOps(
      testUniverse.universe.accounts[0],
      function() {
        eLazy.event('ops-done');
      });
  });

  T.check('Expect the messages to still be in the outbox', eLazy, function() {
    eLazy.expect_namedValue('outbox count', subjects.length);
    eLazy.namedValue('outbox count', views.outbox.slice.items.length);
  });

  T.group('Reenable outbox sync');
  testUniverse.do_setOutboxSyncEnabled(true);

  T.check('Try to send again, should succeed', eLazy, function() {
    if (TEST_PARAMS.type === 'imap') {
      RT.reportActiveActorThisStep(testAccount.eFolderAccount);
      testAccount.eFolderAccount.ignore_createConnection();
      testAccount.eFolderAccount.ignore_reuseConnection();
      testAccount.eFolderAccount.ignore_releaseConnection();
    }

    // Both messages should send successfully.
    testAccount.expect_sendOutboxMessages();
    testAccount.expect_saveSentMessage();
    testAccount.expect_sendOutboxMessages();
    testAccount.expect_saveSentMessage();

    testUniverse.universe.sendOutboxMessages(testUniverse.universe.accounts[0]);

    eLazy.expect_event('ops-done');
    testUniverse.universe.waitForAccountOps(
      testUniverse.universe.accounts[0],
      function() {
        eLazy.event('ops-done');
      });
  });

  T.check('Expect the messages to be gone from the outbox', eLazy, function() {
    eLazy.expect_namedValue('outbox count', 0);
    eLazy.namedValue('outbox count', views.outbox.slice.items.length);
  });

  folders.sent = testAccount.do_useExistingFolderWithType('sent', '');
  views.sent = testAccount.do_openFolderView(
    'sent', folders.sent, null, null, {
      syncedToDawnOfTime: 'ignore',
    });

  T.group('Expect the messages to be sent!');
  // They should show up in the sent folder.
  subjects.forEach(function(subject) {
    testAccount.do_waitForMessage(views.sent, subject, {
      expect: function() {
        RT.reportActiveActorThisStep(eLazy);
        eLazy.expect_namedValue('subject', subject);
      },
      withMessage: function(header) {
        eLazy.namedValue('subject', header.subject);
      }
    }).timeoutMS = TEST_PARAMS.slow ? 30000 : 5000;
  });

  for (var key in views) {
    testAccount.do_closeFolderView(views[key]);
  }

  testUniverse.do_saveState();
  testUniverse.do_shutdown();
});

}); // end define

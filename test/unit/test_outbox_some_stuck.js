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
  { id: 'test_outbox_some_stuck' }, null,
  [$th_imap.TESTHELPER, $th_devicestorage.TESTHELPER], ['app']);

// We cannot use a static subject in case we run this test on a real
// server, which may have messages in folders already.
function makeRandomSubject() {
  return 'Composition: ' + Date.now() +  Math.random() * 100000;
}

// 3) A variant where we send 2 both fail. We tell the fake-server to
// only let the second message through but still fail the first
// message. Trigger re-send, make sure the first message is still
// stuck in the outbox. Clear the problem, then let it get sent.
TD.commonCase('fail the first message, succeed the second', function(T, RT) {
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

  ['inbox', 'localdrafts', 'outbox'].forEach(function(type) {
    folders[type] = testAccount.do_useExistingFolderWithType(type, '');
    views[type] = testAccount.do_openFolderView(
      type, folders[type], null, null, {
        syncedToDawnOfTime: 'ignore',
        nonet: (['outbox', 'localdrafts'].indexOf(type) !== -1)
      });
  });

  // Send two messages. The first one fails and gets stuck in the
  // outbox because it had an invalid 'to' address; the second one
  // sends successfully.

  subjects.forEach(function(subject, idx) {
    var succeedThisMessage = (idx === 1);

    T.group('Send "' + subject + '"');

    testAccount.do_composeAndSendMessage(
      subject,
      {
        success: succeedThisMessage,
        to: (succeedThisMessage ? null : 'invalid@'),
        existingRetryResults: idx ? ['failure'] : [],
        outboxView: views.outbox
      });

    if (!succeedThisMessage) {
      testAccount.do_waitForMessage(views.outbox, subject, {
        expect: function() {
          RT.reportActiveActorThisStep(eLazy);
          eLazy.expect_namedValue('subject', subject);
        },
        withMessage: function(header) {
          eLazy.namedValue('subject', header.subject);
        }
      }).timeoutMS = TEST_PARAMS.slow ? 10000 : 5000;
    }
  });

  T.check('Artificially correct the invalid address', eLazy, function() {
    var outboxHeader = views.outbox.slice.items[0];
    var storage = testAccount.folderAccount.getFolderStorageForFolderId(
      folders.outbox.id);
    eLazy.expect_value('done');
    var id = parseInt(outboxHeader.id.substring(
      outboxHeader.id.lastIndexOf('/') + 1));

    // Mutate the header in-place.
    storage.updateMessageHeader(
      outboxHeader.date.valueOf(),
      id,
      /* partOfSync */ false,
      function(header) {
        header.to[0].address = TEST_PARAMS.emailAddress;
        return true;
      },
      /* body hint */ null, function() {
        eLazy.value('done');
      });
  });

  T.check('send', eLazy, function() {
    testAccount.expect_sendOutboxMessages();
    testAccount.expect_saveSentMessage('conn');
    eLazy.expect_event('sent');
    testUniverse.universe.sendOutboxMessages(testUniverse.universe.accounts[0]);
    testUniverse.MailAPI.onbackgroundsendstatus = function(data) {
      if (data.state === 'success') {
        eLazy.event('sent');
      }
    };
  });

  // Ensure there are no more outbox messages.
  T.check('outbox messages deleted', eLazy, function() {
    eLazy.expect_namedValue('outbox count', 0);
    testAccount.MailAPI.ping(function() {
      eLazy.namedValue('outbox count', views.outbox.slice.items.length);
    });
  });

  for (var key in views) {
    testAccount.do_closeFolderView(views[key]);
  }

  testUniverse.do_saveState();
});




}); // end define

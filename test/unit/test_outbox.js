/**
 * Test several scenarios related to sending messages, focusing on how
 * they interact with the outbox and localdrafts. This particular test
 * file assumes that there is coverage elsewhere (as in
 * `test_compose.js`) for message-specific edge cases like attachments,
 * MIME parsing, and other such stuff.
 */
define(['rdcommon/testcontext', './resources/th_main',
        './resources/th_devicestorage', './resources/messageGenerator',
        'mailapi/util', 'mailapi/accountcommon', 'exports'],
       function($tc, $th_imap, $th_devicestorage, $msggen,
                $util, $accountcommon, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_outbox' }, null,
  [$th_imap.TESTHELPER, $th_devicestorage.TESTHELPER], ['app']);

// We cannot use a static subject in case we run this test on a real
// server, which may have messages in folders already.
function makeRandomSubject() {
  return 'Composition: ' + Date.now() +  Math.random() * 100000;
}


/**
 * Helper method to compose and send a message.
 *
 * @param {object} env
 *   Object with a bunch of keys like testUniverse, testAccount, and other
 *   test-specific things, for convenience of extraction.
 * @param {string} subject
 *   Subject for this message.
 * @param {object} opts
 *   Optional test-specific things. This could be cleaned up.
 * @param {string} opts.to
 *   Override the message's address with this parameter.
 * @param {boolean} opts.success
 *   If true, assert things that indicate that the message sent successfully.
 *   Otherwise, assert that the message failed to send, and is still in the
 *   outbox.
 */
function do_composeAndSendMessage(env, subject, opts) {
  var shouldSucceed = opts.success;
  var eLazy = env.eLazy, T = env.T, RT = env.RT, testAccount = env.testAccount,
      testUniverse = env.testUniverse, outboxView = env.outboxView;
  var TEST_PARAMS = RT.envOptions;
  var composer;

  T.action('begin composition', eLazy, function() {
    eLazy.expect_event('compose setup completed');
    composer = testUniverse.MailAPI.beginMessageComposition(
      null, testUniverse.allFoldersSlice.getFirstFolderWithType('inbox'), null,
      eLazy.event.bind(eLazy, 'compose setup completed'));
  });

  T.action('compose and send', eLazy, function() {
    composer.to.push({ name: 'Myself',
                       address: opts.to || TEST_PARAMS.emailAddress });
    composer.subject = subject;
    composer.body.text = 'Antelope banana credenza.\n\nDialog excitement!';
    testAccount.expect_runOp(
      'saveDraft',
      { local: true, server: false, save: 'local' });

    if (shouldSucceed) {
      testAccount.expect_sendMessageWithOutbox(true);
      eLazy.expect_event('sent');
    } else {
      testAccount.expect_moveMessageToOutbox();
      testAccount.expect_sendOutboxMessages();
      eLazy.expect_event('send-failed');
    }

    // We're going to automatically kick off a round of sending other
    // messages in the outbox (see `outbox.js` docs), so expect one
    // job for each existing message.
    for (var i = 0; i < outboxView.slice.items.length - 1; i++) {
      testAccount.expect_sendOutboxMessages();
    }

    composer.finishCompositionSendMessage();

    eLazy.expect_event('ops-done');
    function done() {
      testUniverse.MailAPI.onbackgroundsendstatus = null;
      testUniverse.universe.waitForAccountOps(
        testUniverse.universe.accounts[0],
        function() {
          eLazy.event('ops-done');
        });
    }

    testUniverse.MailAPI.onbackgroundsendstatus = function(data) {
      if (!data.emitNotifications) {
        return;
      }
      if (data.state === 'success') {
        eLazy.event('sent');
        done();
      } else if (data.state === 'error') {
        eLazy.event('send-failed');
        done();
      }
    };

  }).timeoutMS = TEST_PARAMS.slow ? 10000 : 5000;
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

  var env = {
    T: T,
    RT: RT,
    testUniverse: testUniverse,
    testAccount: testAccount,
    eLazy: eLazy,
    outboxView: views.outbox
  };

  // Send two messages. They both fail and get stuck in the outbox.

  T.check('Force send failure', function() {
    testAccount.testServer.toggleSendFailure(true);
  });

  subjects.forEach(function(subject, idx) {
    T.group('Send "' + subject + '"');
    do_composeAndSendMessage(env, subject, { success: false });

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
    testAccount.expect_sendMessage();
    testAccount.expect_sendOutboxMessages();
    testAccount.expect_sendMessage();

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
      nonet: true
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


// 2) Try to send two messages, both fail. Clean shutdown the
// universe. Start the universe back up. Have the automatic-ish "send
// everything in the inbox" flow trigger and everything get sent.
TD.commonCase('send from clean new universe', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U');
  var testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse,
                              restored: true });
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
        recreateFolder: true,
        nonet: true //(['outbox', 'localdrafts'].indexOf(type) !== -1)
      });
  });

  var env = {
    T: T,
    RT: RT,
    testUniverse: testUniverse,
    testAccount: testAccount,
    eLazy: eLazy,
    outboxView: views.outbox
  };

  // Send two messages. They both fail and get stuck in the outbox.

  T.check('Force send failure', function() {
    testAccount.testServer.toggleSendFailure(true);
  });

  subjects.forEach(function(subject, idx) {
    T.group('Send "' + subject + '"');
    do_composeAndSendMessage(env, subject, { success: false });

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

  // Shut down the first universe.
  for (var key in views) {
    testAccount.do_closeFolderView(views[key]);
  }
  testUniverse.do_saveState();
  testUniverse.do_shutdown();
  // BEGIN UNIVERSE 2

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

  T.check('Try to send all msgs online, should work', eLazy, function() {
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

  views2.sent = testAccount.do_openFolderView(
    'sent', testAccount.do_useExistingFolderWithType('sent', ''), null, null, {
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

// 3) A variant where we send 2 both fail. We tell the fake-server to
// only let the second message through but still fail the first
// message. Trigger re-send, make sure the first message is still
// stuck in the outbox. Clear the problem, then let it get sent.
TD.commonCase('fail the first message, succeed the second', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U', { realDate: true });
  var testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true });
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

  var env = {
    T: T,
    RT: RT,
    testUniverse: testUniverse,
    testAccount: testAccount,
    eLazy: eLazy,
    outboxView: views.outbox
  };

  // Send two messages. The first one fails and gets stuck in the
  // outbox because it had an invalid 'to' address; the second one
  // sends successfully.

  subjects.forEach(function(subject, idx) {
    var succeedThisMessage = (idx === 1);

    T.group('Send "' + subject + '"');

    do_composeAndSendMessage(env, subject, {
      success: succeedThisMessage,
      to: (succeedThisMessage ? null : 'invalid@')
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
      }).timeoutMS = TEST_PARAMS.slow ? 30000 : 5000;
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

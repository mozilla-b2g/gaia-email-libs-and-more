define(['exports'], function(exports) {

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
 * @param {array} [opts.existingRetryResults]
 *   A list with one item for each already existing message in the outbox where
 *   the item is 'success' if we expect the send to succeed, or false if we
 *   expect it to fail.
 * @param {boolean} opts.success
 *   If true, assert things that indicate that the message sent successfully.
 *   Otherwise, assert that the message failed to send, and is still in the
 *   outbox.
 */
exports.do_composeAndSendMessage =
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
      testAccount.expect_sendMessageWithOutbox('success', 'conn');
      eLazy.expect_event('sent');
    } else {
      testAccount.expect_moveMessageToOutbox();
      testAccount.expect_sendOutboxMessages();
      eLazy.expect_event('send-failed');
    }

    var existingRetryResults = opts.existingRetryResults || [];
    if (existingRetryResults.length < outboxView.slice.items.length - 1) {
      throw new Error('Incorrect existingRetryResults argument provided; ' +
                      'length is ' + existingRetryResults.length + ' but ' +
                      'should be ' + (outboxView.slice.items.length - 1));
    }
    for (var i = 0; i < existingRetryResults.length; i++) {
      testAccount.expect_sendOutboxMessages();
      if (existingRetryResults[i] === 'success') {
        testAccount.expect_saveSentMessage();
      }
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
};

});

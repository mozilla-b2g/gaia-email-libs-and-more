/**
 * Test the composition process and our ability to properly display newly
 * received messages.
 **/

load('resources/loggest_test_framework.js');

var TD = $tc.defineTestsFor(
  { id: 'test_compose' }, null, [$th_imap.TESTHELPER], ['app']);

/**
 * Compose a new message from scratch without saving it to drafts, verify that
 * we think it was sent, verify that we received it (which is also a good test
 * of refresh).
 */
TD.commonCase('compose, reply', function(T, RT) {
  var testUniverse = T.actor('testUniverse', 'U', { realDate: true }),
      testAccount = T.actor('testImapAccount', 'A', { universe: testUniverse });

  var uniqueSubject = 'Composition: ' + Date.now() + ' ' +
        Math.floor(Math.random() * 100000);

  var composer, eLazy = T.lazyLogger('misc');
  // - open the folder
  var inboxFolder = testAccount.do_useExistingFolder('INBOX', ''),
      inboxView = testAccount.do_openFolderView('inbox', inboxFolder, null),
      replyComposer, expectedReplyBody;

  // - compose and send
  T.action('begin composition', eLazy, function() {
    eLazy.expect_event('compose setup completed');
    composer = MailAPI.beginMessageComposition(
      null, gAllFoldersSlice.getFirstFolderWithType('inbox'), null,
      eLazy.event.bind(eLazy, 'compose setup completed'));
  });
  T.action('send', eLazy, function() {
    eLazy.expect_event('sent');

    composer.to.push({ name: 'Myself', address: TEST_PARAMS.emailAddress });
    composer.subject = uniqueSubject;
    composer.body = 'Antelope banana credenza.\n\nDialog excitement!';

    composer.finishCompositionSendMessage(function(err, badAddrs) {
      if (err)
        eLazy.error(err);
      else
        eLazy.event('sent');
    });
  }).timeoutMS = 5000;

  // - see the new message, start to reply to the message!
  testAccount.do_waitForMessage(inboxView, uniqueSubject, {
    expect: function() {
      RT.reportActiveActorThisStep(eLazy);
      // We are top-posting biased, so we automatically insert two blank lines;
      // one for typing to start at, and one for whitespace purposes.
      expectedReplyBody = {
        text: [
          '', '',
          TEST_PARAMS.name + ' wrote:',
          '> Antelope banana credenza.',
          '>',
          '> Dialog excitement!',
          '', '-- ', $_mailuniverse.DEFAULT_SIGNATURE, '',
        ].join('\n'),
        html: null
      };
      eLazy.expect_event('reply setup completed');
      eLazy.expect_namedValue('to', [{ name: TEST_PARAMS.name,
                                       address: TEST_PARAMS.emailAddress }]);
      eLazy.expect_namedValue('subject', 'Re: ' + uniqueSubject);
      eLazy.expect_namedValue('body', expectedReplyBody);
    },
    // trigger the reply composer
    withMessage: function(header) {
      replyComposer = header.replyToMessage('sender', function() {
        eLazy.event('reply setup completed');
        eLazy.namedValue('to', replyComposer.to);
        eLazy.namedValue('subject', replyComposer.subject);
        eLazy.namedValue('body', replyComposer.body);
      });
    },
  });
  // - complete and send the reply
  T.action('reply', eLazy, function() {
    eLazy.expect_event('sent');
    replyComposer.body = expectedReplyBody =
      'This bit is new!' + replyComposer.body;
    replyComposer.finishCompositionSendMessage(function(err, badAddrs) {
      if (err)
        eLazy.error(err);
      else
        eLazy.event('sent');
    });
  }).timeoutMS = 5000;
  // - see the reply, check the forward logic (but don't send)
  // XXX for now, we are not creating the 'header' overview for the forwarded
  // message.
  var forwardComposer, expectedForwardBody;
  testAccount.do_waitForMessage(inboxView, 'Re: ' + uniqueSubject, {
    expect: function() {
      RT.reportActiveActorThisStep(eLazy);
      expectedForwardBody = {
        text: [
          '', '',
          '-- ', $_mailuniverse.DEFAULT_SIGNATURE, '',
          '-------- Original Message --------',
          expectedReplyBody
        ].join('\n'),
        html: null
      };

      eLazy.expect_event('forward setup completed');
      // these are expectations on the forward...
      eLazy.expect_namedValue('to', []);
      eLazy.expect_namedValue('subject', 'Fwd: Re: ' + uniqueSubject);
      eLazy.expect_namedValue('body', expectedForwardBody);

    },
    withMessage: function(header) {
    forwardComposer = header.forwardMessage('inline', function() {
        eLazy.event('forward setup completed');
        eLazy.namedValue('to', forwardComposer.to);
        eLazy.namedValue('subject', forwardComposer.subject);
        eLazy.namedValue('body', forwardComposer.body);
      });
    },
  });
});

/**
 * Start message composition, close out the composition, check that the
 * resulting draft looks like what we expect, resume composition of the
 * draft.
 */
//add_test(function test_compose_and_resume() {
//});

function run_test() {
  runMyTests(15);
}

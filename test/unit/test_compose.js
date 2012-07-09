/**
 * Test the composition process.
 **/

load('resources/loggest_test_framework.js');

var TD = $tc.defineTestsFor(
  { id: 'blah' }, null, [$th_imap.TESTHELPER], ['app']);

/**
 * Compose a new message from scratch without saving it to drafts, verify that
 * we think it was sent.
 *
 * XXX todo: verify that our account received it.
 */
TD.commonCase('compose, verify, reply, verify', function(T) {
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A', { universe: testUniverse });

  var uniqueSubject = 'Composition: ' + Date.now() + ' ' +
        Math.floor(Math.random() * 100000);

  var composer, eLazy = T.lazyLogger('misc');
  T.action('begin composition', eLazy, function() {
    eLazy.expect_event('setup completed');
    composer = MailAPI.beginMessageComposition(
      null, gAllFoldersSlice.getFirstFolderWithType('inbox'), null,
      eLazy.event.bind(eLazy, 'setup completed'));
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

  var inboxFolder = testAccount.do_useExistingFolder('INBOX', ''),
      inboxView = testAccount.do_viewFolder('open', inboxFolder, null),
      replyComposer;
  testAccount.do_waitForMessage(inboxView, uniqueSubject, {
    expect: function() {
      T.reportActiveActorThisStep(eLazy);
      // We are top-posting biased, so we automatically insert two blank lines;
      // one for typing to start at, and one for whitespace purposes.
      var expectedBody = [
          '', '',
          TEST_PARAMS.name + ' wrote:',
          '> Antelope banana credenza.',
          '>',
          '> Dialog excitement!',
        ].join('\n');
      eLazy.expect_event('setup completed');
      eLazy.expect_namedValue('to', [{ name: TEST_PARAMS.name,
                                       address: TEST_PARAMS.emailAddress }]);
      eLazy.expect_namedValue('subject', 'Re: ' + uniqueSubject);
      eLazy.expect_namedValue('body', expectedBody);
    },
    withMessage: function(header) {
      replyComposer = header.replyToMessage('sender', function() {
        eLazy.event('setup completed');
        eLazy.namedValue('to', replyComposer.to);
        eLazy.namedValue('subject', replyComposer.subject);
        eLazy.namedValue('body', replyComposer.body);
      });
    },
  });
  T.action('reply', eLazy, function() {
    eLazy.expect_event('sent');
    replyComposer.body = 'This bit is new!' + replyComposer.body;
    replyComposer.finishCompositionSendMessage(function(err, badAddrs) {
      if (err)
        eLazy.error(err);
      else
        eLazy.event('sent');
    });
  }).timeoutMS = 5000;
  testAccount.do_waitForMessage(inboxView, 'Re: ' + uniqueSubject, {});
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

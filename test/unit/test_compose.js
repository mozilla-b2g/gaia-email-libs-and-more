/**
 * Test the composition process and our ability to properly display newly
 * received messages.
 **/

load('resources/loggest_test_framework.js');
// currently the verbatim thunderbird message generator dude
load('resources/messageGenerator.js');

var TD = $tc.defineTestsFor(
  { id: 'test_compose' }, null, [$th_imap.TESTHELPER], ['app']);

/**
 * Create a nondeterministic subject (in contrast to what TB's messageGenerator
 * does because unit tests usually like determinism.)
 */
function makeRandomSubject() {
  return 'Composition: ' + Date.now() + ' ' +
    Math.floor(Math.random() * 100000);
}

/**
 * Compose a new message from scratch without saving it to drafts, verify that
 * we think it was sent, verify that we received it (which is also a good test
 * of refresh).
 */
TD.commonCase('compose, reply (text/plain)', function(T, RT) {
  var testUniverse = T.actor('testUniverse', 'U', { realDate: true }),
      testAccount = T.actor('testImapAccount', 'A', { universe: testUniverse });

  var uniqueSubject = makeRandomSubject();

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
    composer.body.text = 'Antelope banana credenza.\n\nDialog excitement!';

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
      eLazy.expect_namedValue('body text', expectedReplyBody.text);
      eLazy.expect_namedValue('body html', expectedReplyBody.html);
    },
    // trigger the reply composer
    withMessage: function(header) {
      replyComposer = header.replyToMessage('sender', function() {
        eLazy.event('reply setup completed');
        eLazy.namedValue('to', replyComposer.to);
        eLazy.namedValue('subject', replyComposer.subject);
        eLazy.namedValue('body text', replyComposer.body.text);
        eLazy.namedValue('body html', replyComposer.body.html);
      });
    },
  });
  // - complete and send the reply
  T.action('reply', eLazy, function() {
    eLazy.expect_event('sent');
    replyComposer.body.text = expectedReplyBody.text =
      'This bit is new!' + replyComposer.body.text;
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
          expectedReplyBody.text
        ].join('\n'),
        html: null
      };

      eLazy.expect_event('forward setup completed');
      // these are expectations on the forward...
      eLazy.expect_namedValue('to', []);
      eLazy.expect_namedValue('subject', 'Fwd: Re: ' + uniqueSubject);
      eLazy.expect_namedValue('body text', expectedForwardBody.text);
      eLazy.expect_namedValue('body html', expectedForwardBody.html);
    },
    withMessage: function(header) {
    forwardComposer = header.forwardMessage('inline', function() {
        eLazy.event('forward setup completed');
        eLazy.namedValue('to', forwardComposer.to);
        eLazy.namedValue('subject', forwardComposer.subject);
        eLazy.namedValue('body text', forwardComposer.body.text);
        eLazy.namedValue('body html', forwardComposer.body.html);
      });
    },
  });
});


/**
 * Since we currently don't really support composing HTML, we cram an HTML
 * message into the inbox so that we can reply to it.
 */
TD.commonCase('reply/forward html message', function(T, RT) {
  var testUniverse = T.actor('testUniverse', 'U', { realDate: true }),
      testAccount = T.actor('testImapAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eCheck = T.lazyLogger('messageCheck');

  var
      bstrHtml =
        '<html><head></head><body>' +
        '<style type="text/css">p { margin: 0; }</style>' +
        '<p>I am the reply to the quote below.</p>' +
        '<blockquote><p>I am the replied-to text!</p></blockquote></body></html>',
      bstrSanitizedHtml =
        '<style type="text/css">p { margin: 0; }</style>' +
        '<p>I am the reply to the quote below.</p>' +
        '<blockquote><p>I am the replied-to text!</p></blockquote>',
      // the text bit of the reply to the above
      replyTextHtml =
        // no trailing newline when followed by an HTML chunk
        '\n\n$AUTHOR$ wrote:',
      // the (read-only) bit of the reply to the above
      replyHtmlHtml  =
        '<blockquote cite="mid:$MESSAGEID$" type="cite">' +
        // XXX we want this style scoped
        // XXX aaaaaargh. our sanitizer is falling victim to platform
        // helpfulness and turns "margin: 0;" into
        // "margin-top: 0px; margin-bottom: 0px;"
        '<style type="text/css">' +
        'p { margin-top: 0px; margin-bottom: 0px; }' +
        '</style>' +
        '<p>I am the reply to the quote below.</p>' +
        '<blockquote><p>I am the replied-to text!</p></blockquote>' +
        '</blockquote>' +
        '<pre class="moz-signature" cols="72">' +
        $_mailuniverse.DEFAULT_SIGNATURE +
        '</pre>',
      bpartHtml =
        new SyntheticPartLeaf(
          bstrHtml,  { contentType: 'text/html' });

  var uniqueSubject = makeRandomSubject();

  var msgDef = {
    subject: uniqueSubject,
    from: [TEST_PARAMS.name, TEST_PARAMS.emailAddress],
    messageId: makeRandomSubject().replace(/[: ]+/g, ''),
    bodyPart: bpartHtml,
    checkReply: {
      text: replyTextHtml,
      html: replyHtmlHtml,
    }
  };

  var inboxFolder = testAccount.do_useExistingFolder('INBOX', '');

  var inboxView = testAccount.do_openFolderView('inbox', inboxFolder, null);

  testAccount.do_addMessagesToFolder(
    inboxFolder, function makeMessages() {
    var messageAppends = [], msgGen = new MessageGenerator();

    msgDef.age = { minutes: 1 };
    var synMsg = msgGen.makeMessage(msgDef);
    messageAppends.push({
      date: synMsg.date,
      headerInfo: {
        subject: synMsg.subject,
      },
      messageText: synMsg.toMessageString(),
    });

    return messageAppends;
  });

  var expectedReplyBody, header;
  testAccount.do_waitForMessage(inboxView, uniqueSubject, {
    expect: function() {
      RT.reportActiveActorThisStep(eCheck);
      eCheck.expect_event('got header');
    },
    withMessage: function(_header) {
      header = _header;
      eCheck.event('got header');
    }
  });
  T.action(eCheck,
           'reply to HTML message', msgDef.name, function() {
    expectedReplyBody = {
      text: replyTextHtml.replace('$AUTHOR$', TEST_PARAMS.name),
      html: replyHtmlHtml.replace('$MESSAGEID$', header.guid)
    };

    eCheck.expect_namedValue('reply text', expectedReplyBody.text);
    eCheck.expect_namedValue('reply html', expectedReplyBody.html);

    eCheck.expect_event('sent');

    header.replyToMessage('sender', function(composer) {
      eCheck.namedValue('reply text', composer.body.text);
      eCheck.namedValue('reply html', composer.body.html);

      composer.finishCompositionSendMessage(function(err, badAddrs) {
        if (err)
          eCheck.error(err);
        else
          eCheck.event('sent');
      });
    });
  });
  testAccount.do_waitForMessage(inboxView, 'Re: ' + uniqueSubject, {
    expect: function() {
      RT.reportActiveActorThisStep(eCheck);

      var expectedHtmlRep = [
        '<div>',
        expectedReplyBody.text.replace(/\n/g, '<br>'),
        '</div>',
        expectedReplyBody.html,
      ].join('');
      eCheck.expect_namedValue('rep type', 'html');
      eCheck.expect_namedValue('rep', expectedHtmlRep);
    },
    // trigger the reply composer
    withMessage: function(header) {
      header.getBody(function(body) {
        eCheck.namedValue('rep type', body.bodyReps[0]);
        eCheck.namedValue('rep', body.bodyReps[1]);
      });
    }
  });
});

function run_test() {
  runMyTests(15);
}

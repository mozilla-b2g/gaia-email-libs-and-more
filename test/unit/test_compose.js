/**
 * Test the composition process and our ability to properly display newly
 * received messages.
 **/

load('resources/loggest_test_framework.js');
// currently the verbatim thunderbird message generator dude
load('resources/messageGenerator.js');

var $util = require('mailapi/util');
var $fakeacct = require('mailapi/fake/account');

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
 * we think it was sent, verify that it ended up in the sent folder, and verify
 * that we received it (which is also a good test of refresh).
 */
TD.commonCase('compose, reply (text/plain), forward', function(T, RT) {
  var testUniverse = T.actor('testUniverse', 'U', { realDate: true }),
      testAccount = T.actor('testImapAccount', 'A', { universe: testUniverse });

  var uniqueSubject = makeRandomSubject();

  var composer, eLazy = T.lazyLogger('misc');
  // - open the folder
  var inboxFolder = testAccount.do_useExistingFolder('INBOX', ''),
      inboxView = testAccount.do_openFolderView('inbox', inboxFolder, null),
      sentFolder = testAccount.do_useExistingFolder('Sent', ''),
      sentView = testAccount.do_openFolderView('sent', sentFolder, null),
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
    eLazy.expect_event('appended');

    composer.to.push({ name: 'Myself', address: TEST_PARAMS.emailAddress });
    composer.subject = uniqueSubject;
    composer.body.text = 'Antelope banana credenza.\n\nDialog excitement!';

    composer.finishCompositionSendMessage(function(err, badAddrs) {
      if (err)
        eLazy.error(err);
      else
        eLazy.event('sent');
      MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
        eLazy.event('appended');
      });
    });
  }).timeoutMS = 5000;

  // - verify sent folder contents
  testAccount.do_waitForMessage(sentView, uniqueSubject, {
    expect: function() {
      RT.reportActiveActorThisStep(eLazy);
      eLazy.expect_namedValue('subject', uniqueSubject);
    },
    withMessage: function(header) {
      eLazy.namedValue('subject', header.subject);
    }
  });

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
          '', '-- ', $_accountcommon.DEFAULT_SIGNATURE, '',
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
  var replySentDate;
  T.action('reply', eLazy, function() {
    eLazy.expect_event('sent');
    replyComposer.body.text = expectedReplyBody.text =
      'This bit is new!' + replyComposer.body.text;
    replyComposer.finishCompositionSendMessage(function(err, badAddrs,
                                                        sentDate) {
      replySentDate = new Date(sentDate);
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
      var formattedMail = $util.formatAddresses(
                            [{ name: TEST_PARAMS.name,
                               address: TEST_PARAMS.emailAddress }]);
      expectedForwardBody = {
        text: [
          '', '',
          '-- ', $_accountcommon.DEFAULT_SIGNATURE, '',
          '-------- Original Message --------',
          'Subject: Re: ' + uniqueSubject,
          'Date: ' + replySentDate,
          'From: ' + formattedMail,
          'To: ' + formattedMail,
          '',
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
        $_accountcommon.DEFAULT_SIGNATURE +
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

/**
 * Test that reply-to-all broadly works (no exception explosions due to its
 * custom logic) and that it adds the author of the message to the 'to' line
 * unless they are already present in either the to list or the cc list.  We
 * generate messages for all 3 cases.
 *
 * We also check that if 'to' or 'cc' is empty that we don't experience a
 * failure.
 *
 * We do not actually do any message sending for this because we don't want to
 * send messages anyplace other than our single test account; we just fabricate
 * made-up messages and check that the compose logic sets things up correctly.
 */
TD.commonCase('reply all', function(T, RT) {
  var testUniverse = T.actor('testUniverse', 'U', { realDate: true }),
      testAccount = T.actor('testImapAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eCheck = T.lazyLogger('messageCheck');


  var senderPair, toPairs, ccPairs;
  var msgNotIn, msgInTo, msgInCc, msgNoCc, msgNoTo;
  var testFolder = testAccount.do_createTestFolder(
    'test_compose_reply_all',
    function makeMessages() {
      // (note: fake account's generator used because it produces names and
      // addresses that are already aligned with our needs.)
      var fmsgGen = new $fakeacct.MessageGenerator(testAccount._useDate,
                                                   'body');
      senderPair = fmsgGen.makeNameAndAddress();
      toPairs = fmsgGen.makeNamesAndAddresses(4);
      ccPairs = fmsgGen.makeNamesAndAddresses(4);
      var msgs = [];
      // 0: the sender is not already in the to/cc
      msgs.push(fmsgGen.makeMessage(msgNotIn = {
          from: senderPair, to: toPairs, cc: ccPairs, age: { hours: 1 }
        }));
      // 1: the sender is in the 'to' list
      msgs.push(fmsgGen.makeMessage(msgInTo = {
          from: senderPair, to: toPairs.concat([senderPair]), cc: ccPairs,
          age: { hours: 2 }
        }));
      // 2: the sender is in the 'cc' list
      msgs.push(fmsgGen.makeMessage(msgInCc = {
          from: senderPair, to: toPairs, cc: ccPairs.concat([senderPair]),
          age: { hours: 3 }
        }));
      // 3: no 'cc' list at all; sender not in list
      msgs.push(fmsgGen.makeMessage(msgNoCc = {
          from: senderPair, to: toPairs, cc: [],
          age: { hours: 4 }
        }));
      // 4: no 'to' list at all; sender not in list
      msgs.push(fmsgGen.makeMessage(msgNoTo = {
          from: senderPair, to: [], cc: ccPairs,
          age: { hours: 5 }
        }));
      return msgs;
    });
  var testView = testAccount.do_openFolderView('syncs', testFolder,
    { count: 5, full: 5, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false });
  T.action(eCheck, 'reply composer variants', function() {
    var slice = testView.slice;
    var headerNotIn = slice.items[0],
        headerInTo = slice.items[1],
        headerInCc = slice.items[2],
        headerNoCc = slice.items[3],
        headerNoTo = slice.items[4];

    // The not-in case has the sender added to the front of the 'to' list!
    eCheck.expect_namedValue('not-in:to', [senderPair].concat(msgNotIn.to));
    eCheck.expect_namedValue('not-in:cc', msgNotIn.cc);
    var composerNotIn = headerNotIn.replyToMessage('all', function() {
      eCheck.namedValue('not-in:to', composerNotIn.to);
      eCheck.namedValue('not-in:cc', composerNotIn.cc);
    });

    eCheck.expect_namedValue('in-to:to', msgInTo.to);
    eCheck.expect_namedValue('in-to:cc', msgInTo.cc);
    var composerInTo = headerInTo.replyToMessage('all', function() {
      eCheck.namedValue('in-to:to', composerInTo.to);
      eCheck.namedValue('in-to:cc', composerInTo.cc);
    });

    eCheck.expect_namedValue('in-cc:to', msgInCc.to);
    eCheck.expect_namedValue('in-cc:cc', msgInCc.cc);
    var composerInCc = headerInCc.replyToMessage('all', function() {
      eCheck.namedValue('in-cc:to', composerInCc.to);
      eCheck.namedValue('in-cc:cc', composerInCc.cc);
    });

    eCheck.expect_namedValue('no-cc:to', [senderPair].concat(msgNoCc.to));
    eCheck.expect_namedValue('no-cc:cc', null);
    var composerNoCc = headerNoCc.replyToMessage('all', function() {
      eCheck.namedValue('no-cc:to', composerNoCc.to);
      eCheck.namedValue('no-cc:cc', composerNoCc.cc);
    });

    eCheck.expect_namedValue('no-to:to', [senderPair]);
    eCheck.expect_namedValue('no-to:cc', msgNoTo.cc);
    var composerNoTo = headerNoTo.replyToMessage('all', function() {
      eCheck.namedValue('no-to:to', composerNoTo.to);
      eCheck.namedValue('no-to:cc', composerNoTo.cc);
    });
  });
  testAccount.do_closeFolderView(testView);
});

function run_test() {
  runMyTests(15);
}

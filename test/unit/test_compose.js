/**
 * Test the composition process and our ability to properly display newly
 * received messages.
 **/

define(['rdcommon/testcontext', './resources/th_main',
        './resources/th_devicestorage', './resources/messageGenerator',
        'mailapi/util', 'mailapi/accountcommon', 'exports'],
       function($tc, $th_imap, $th_devicestorage, $msggen,
                $util, $accountcommon, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_compose' }, null,
  [$th_imap.TESTHELPER, $th_devicestorage.TESTHELPER], ['app']);

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
TD.commonCase('compose, save, edit, reply (text/plain), forward',
              function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U', { realDate: true }),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse,
                              realAccountNeeded: true }),
      testStorage = T.actor('testDeviceStorage', 'sdcard',
                            { storage: 'sdcard' });

  var uniqueSubject = makeRandomSubject();

  var composer, eLazy = T.lazyLogger('misc');
  // - open the folder
  var inboxFolder = testAccount.do_useExistingFolderWithType('inbox', ''),
      inboxView = testAccount.do_openFolderView(
        'inbox', inboxFolder, null, null,
        { syncedToDawnOfTime: 'ignore' }),
      sentFolder = testAccount.do_useExistingFolderWithType('sent', ''),
      sentView = testAccount.do_openFolderView(
        'sent', sentFolder, null, null,
        { syncedToDawnOfTime: 'ignore' }),
      localDraftsFolder = testAccount.do_useExistingFolderWithType(
        'localdrafts', ''),
      localDraftsView = testAccount.do_openFolderView(
        'localdrafts', localDraftsFolder, null, null,
        { nonet: true }),
      replyComposer, expectedReplyBody;

  // - compose and send
  T.group('compose');
  T.action('begin composition', eLazy, function() {
    eLazy.expect_event('compose setup completed');
    composer = testUniverse.MailAPI.beginMessageComposition(
      null, testUniverse.allFoldersSlice.getFirstFolderWithType('inbox'), null,
      eLazy.event.bind(eLazy, 'compose setup completed'));
  });

  // Have our attachment data:
  // - Contain all possible binary values so we can make sure there are no
  //   encoding snafus.
  // - Be long enough that the base64 encoding will cross multiple lines.
  // - Be non-repeating so that slice errors show up.
  const attachmentData = [];
  for (var iData = 0; iData < 256; iData++) {
    attachmentData.push(iData);
  }

  T.action(testAccount, 'compose, save', eLazy, function() {
    testAccount.expect_runOp(
      'saveDraft',
      { local: true, server: false, save: true });
    eLazy.expect_event('saved');

    composer.to.push({ name: 'Myself', address: TEST_PARAMS.emailAddress });
    composer.subject = uniqueSubject;
    composer.body.text = 'Antelope banana credenza.\n\nDialog excitement!';

    composer.addAttachment({
      name: 'foo.png',
      blob: new Blob([new Uint8Array(attachmentData)], { type: 'image/png' }),
    });

    composer.saveDraft(function() {
      eLazy.event('saved');
    });
    composer.die();
    composer = null;
  });

  var lastDraftId;
  T.action('locate draft header, resume editing', eLazy, function() {
    eLazy.expect_namedValue('draft count', 1);
    eLazy.expect_namedValue('header subject', uniqueSubject);
    eLazy.expect_event('resumed');
    eLazy.expect_namedValue('draft subject', uniqueSubject);
    eLazy.expect_namedValue('draft text',
                            'Antelope banana credenza.\n\nDialog excitement!');

    eLazy.namedValue('draft count', localDraftsView.slice.items.length);
    var draftHeader = localDraftsView.slice.items[0];
    lastDraftId = draftHeader.id;
    eLazy.namedValue('header subject', draftHeader.subject);
    composer = draftHeader.editAsDraft(function() {
      eLazy.event('resumed');
      eLazy.namedValue('draft subject', composer.subject);
      eLazy.namedValue('draft text', composer.body.text);
    });
  });
  T.action(testAccount, 'save draft again, old draft deleted',eLazy,function() {
    testAccount.expect_runOp(
      'saveDraft',
      { local: true, server: false, save: true });

    eLazy.expect_event('saved');
    composer.saveDraft(function() {
      eLazy.event('saved');
    });
  });
  T.check('id change check', eLazy, function() {
    // we could also listen for changes on the view...
    eLazy.expect_namedValue('draft count', 1);
    eLazy.expect_namedValue('header subject', uniqueSubject);
    eLazy.expect_namedValueD('id changed?', true);

    eLazy.namedValue('draft count', localDraftsView.slice.items.length);
    var draftHeader = localDraftsView.slice.items[0];
    eLazy.namedValue('header subject', draftHeader.subject);
    eLazy.namedValueD('id changed?', draftHeader.id !== lastDraftId,
                      draftHeader.id);
    lastDraftId = draftHeader.id;
  });
  T.action(testAccount, 'save draft 2nd time, old draft deleted',
           eLazy, function() {
    testAccount.expect_runOp(
      'saveDraft',
      { local: true, server: false, save: true });

    eLazy.expect_event('saved');
    composer.saveDraft(function() {
      eLazy.event('saved');
    });
  });
  T.check('id change check', eLazy, function() {
    // we could also listen for changes on the view...
    eLazy.expect_namedValue('draft count', 1);
    eLazy.expect_namedValue('header subject', uniqueSubject);
    eLazy.expect_namedValueD('id changed?', true);

    eLazy.namedValue('draft count', localDraftsView.slice.items.length);
    var draftHeader = localDraftsView.slice.items[0];
    eLazy.namedValue('header subject', draftHeader.subject);
    eLazy.namedValueD('id changed?', draftHeader.id !== lastDraftId,
                      draftHeader.id);
    lastDraftId = draftHeader.id;
  });
  var sentMessageId;
  T.action(testAccount, 'send', eLazy, function() {
    // sending is not tracked as an op, but appending is
    testAccount.expect_runOp(
      'append',
      { local: false, server: true, save: false });
    // note: the delete op is asynchronously scheduled by the send process once
    // it completes; our callback below will be invoked before the op is
    // guaranteed to run to completion.
    testAccount.expect_runOp(
      'deleteDraft',
      { local: true, server: false, save: true });

    eLazy.expect_event('sent');

    composer.finishCompositionSendMessage(function(err, badAddrs, debugInfo) {
      sentMessageId = debugInfo.messageId.slice(1, -1); // lose < > wrapping
      if (err)
        eLazy.error(err);
      else
        eLazy.event('sent');
    });
  }).timeoutMS = TEST_PARAMS.slow ? 10000 : 5000;

  T.check('draft message deleted', eLazy, function() {
    eLazy.expect_namedValue('draft count', 0);
    eLazy.namedValue('draft count', localDraftsView.slice.items.length);
  });

  // - verify sent folder contents
  testAccount.do_waitForMessage(sentView, uniqueSubject, {
    expect: function() {
      RT.reportActiveActorThisStep(testAccount.eJobDriver);
      RT.reportActiveActorThisStep(eLazy);
      RT.reportActiveActorThisStep(testStorage);
      eLazy.expect_namedValue('subject', uniqueSubject);
      eLazy.expect_namedValue('message-id', sentMessageId);
      eLazy.expect_namedValue(
        'attachments',
        [{
          filename: 'foo.png',
          mimetype: 'image/png',
          // there is some guessing/rounding involved
          sizeEstimateInBytes: testAccount.exactAttachmentSizes ? 256 : 257,
         }]);
      testAccount.eJobDriver.expect_savedAttachment('sdcard', 'image/png', 256);
      // adding a file sends created and modified
      testStorage.expect_created('foo.png');
      testStorage.expect_modified('foo.png');
      eLazy.expect_namedValue(
        'attachment[0].size', 256);
      eLazy.expect_namedValue(
        'attachment[0].data', attachmentData.concat());
    },
    withMessage: function(header) {
      eLazy.namedValue('subject', header.subject);
      eLazy.namedValue('message-id', header.guid);
      header.getBody(function(body) {
        var attachments = [];
        body.attachments.forEach(function(att, iAtt) {
          attachments.push({
            filename: att.filename,
            mimetype: att.mimetype,
            sizeEstimateInBytes: att.sizeEstimateInBytes,
          });
          att.download(function() {
            testStorage.get(
              att._file[1],
              function gotBlob(error, blob) {
                if (error) {
                  console.error('blob fetch error:', error);
                  return;
                }
                var reader = new FileReaderSync();
                try {
                  var data = new Uint8Array(reader.readAsArrayBuffer(blob));
                  var dataArr = [];
                  console.log('got', data.length, 'bytes, readyState',
                              reader.readyState);
                  for (var i = 0; i < data.length; i++) {
                    dataArr.push(data[i]);
                  }
                  eLazy.namedValue('attachment[' + iAtt + '].size',
                                   body.attachments[iAtt].sizeEstimateInBytes);
                  eLazy.namedValue('attachment[' + iAtt + '].data',
                                   dataArr);
                }
                catch(ex) {
                  console.error('reader error', ex);
                }
              });
          });
        });
        eLazy.namedValue('attachments', attachments);
      });
    }
  }).timeoutMS = TEST_PARAMS.slow ? 30000 : 5000;

  // - see the new message, start to reply to the message!
  T.group('see sent message, reply');
  testAccount.do_waitForMessage(inboxView, uniqueSubject, {
    expect: function() {
      RT.reportActiveActorThisStep(eLazy);
      eLazy.expect_namedValue('source message-id', sentMessageId);
      // We are top-posting biased, so we automatically insert two blank lines;
      // one for typing to start at, and one for whitespace purposes.
      expectedReplyBody = {
        text: [
          '', '',
          TEST_PARAMS.name + ' wrote:',
          '> Antelope banana credenza.',
          '>',
          '> Dialog excitement!',
          // XXX we used to have a default signature; when we start letting
          // users configure signatures again, then we will want the test to
          // use one and put this back.
          //'', '-- ', $accountcommon.DEFAULT_SIGNATURE, '',
        ].join('\n'),
        html: null
      };
      eLazy.expect_event('reply setup completed');
      eLazy.expect_namedValue('to', [{ name: TEST_PARAMS.name,
                                       address: TEST_PARAMS.emailAddress }]);
      eLazy.expect_namedValue('subject', 'Re: ' + uniqueSubject);
      eLazy.expect_namedValue('references', '<' + sentMessageId + '>');
      eLazy.expect_namedValue('body text', expectedReplyBody.text);
      eLazy.expect_namedValue('body html', expectedReplyBody.html);
    },
    // trigger the reply composer
    withMessage: function(header) {
      eLazy.namedValue('source message-id', header.guid);
      replyComposer = header.replyToMessage('sender', function() {
        eLazy.event('reply setup completed');
        eLazy.namedValue('to', replyComposer.to);
        eLazy.namedValue('subject', replyComposer.subject);
        eLazy.namedValue('references', replyComposer._references);
        eLazy.namedValue('body text', replyComposer.body.text);
        eLazy.namedValue('body html', replyComposer.body.html);
      });
    },
  }).timeoutMS = TEST_PARAMS.slow ? 30000 : 5000;

  // - complete and send the reply
  var replySentDate, replyMessageId, replyReferences;
  T.action('reply', eLazy, function() {
    eLazy.expect_event('sent');
    replyComposer.body.text = expectedReplyBody.text =
      'This bit is new!' + replyComposer.body.text;
    replyComposer.finishCompositionSendMessage(function(err, badAddrs,
                                                        debugInfo) {
      replySentDate = new Date(debugInfo.sentDate);
      replyMessageId = debugInfo.messageId.slice(1, -1); // lose <> wrapping
      replyReferences = [sentMessageId];
      if (err)
        eLazy.error(err);
      else
        eLazy.event('sent');
    });
  }).timeoutMS = 5000;
  // - see the reply, check the forward logic (but don't send)
  // XXX for now, we are not creating the 'header' overview for the forwarded
  // message.

  // The sent date is not going to be the same as the internaldate in many
  // cases, so we need to just XX out the time since strict equivalence is
  // not going to let us do an epsilon.
  function safeifyTime(s) {
    return s.replace(/ \d{2}:\d{2}:\d{2} /, 'XX:XX:XX');
  }

  var replyHeader;
  T.group('check reply');
  var forwardComposer, expectedForwardBody;
  testAccount.do_waitForMessage(inboxView, 'Re: ' + uniqueSubject, {
    expect: function() {
      RT.reportActiveActorThisStep(eLazy);

      eLazy.expect_namedValue('replied message-id', replyMessageId);
      eLazy.expect_namedValue('replied references', replyReferences);
    },
    withMessage: function(header) {
      replyHeader = header;
      eLazy.namedValue('replied message-id', header.guid);
      header.getBody(function(repliedBody) {
        eLazy.namedValue('replied references', repliedBody._references);
      });
    },
  }).timeoutMS = TEST_PARAMS.slow ? 30000 : 5000;
  T.group('check forward generation logic');
  T.check('check forward', eLazy, function() {
    var formattedMail = $util.formatAddresses(
                          [{ name: TEST_PARAMS.name,
                             address: TEST_PARAMS.emailAddress }]);
    expectedForwardBody = {
      text: [
        '', '',
        // XXX when signatures get enabled/tested:
        // '-- ', $accountcommon.DEFAULT_SIGNATURE, '',
        '-------- Original Message --------',
        'Subject: Re: ' + uniqueSubject,
        'Date: ' + safeifyTime(replySentDate + ''),
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

    forwardComposer = replyHeader.forwardMessage('inline', function() {
      eLazy.event('forward setup completed');
      eLazy.namedValue('to', forwardComposer.to);
      eLazy.namedValue('subject', forwardComposer.subject);
      eLazy.namedValue('body text', safeifyTime(forwardComposer.body.text));
      eLazy.namedValue('body html', forwardComposer.body.html);

      forwardComposer.die();
    });
  });

  T.group('reply to the reply');
  var secondReplySentDate, secondReplyMessageId, secondReplyReferences;
  T.action('reply to the reply', eLazy, function() {
    eLazy.expect_event('sent');

    var secondReplyComposer = replyHeader.replyToMessage('sender', function() {
      secondReplyComposer.body.text = expectedReplyBody.text =
        'And now this bit is new.' + replyComposer.body.text;
      // XXX hack to let us match by subject, but we should just modify/augment
      // do_waitForMessage to support matching on message-id since we surface
      // that as the 'guid'.
      secondReplyComposer.subject += '[2]';
      secondReplyComposer.finishCompositionSendMessage(function(err, badAddrs,
                                                                debugInfo) {
        secondReplySentDate = new Date(debugInfo.sentDate);
        secondReplyMessageId = debugInfo.messageId.slice(1, -1);
        secondReplyReferences = replyReferences.concat([replyMessageId]);
        if (err)
          eLazy.error(err);
        else
          eLazy.event('sent');
      });
    });
  });
  testAccount.do_waitForMessage(inboxView, 'Re: ' + uniqueSubject + '[2]', {
    expect: function() {
      RT.reportActiveActorThisStep(eLazy);

      eLazy.expect_namedValue('replied message-id', secondReplyMessageId);
      eLazy.expect_namedValue('replied references', secondReplyReferences);
    },
    withMessage: function(header) {
      replyHeader = header;
      eLazy.namedValue('replied message-id', header.guid);
      header.getBody(function(body) {
        eLazy.namedValue('replied references', body._references);
      });
    },
  }).timeoutMS = TEST_PARAMS.slow ? 30000 : 5000;


  T.group('cleanup');
  // Make sure the append operation's success gets persisted; this is a testing
  // hack until we ensure that the operation log gets persisted more frequently.
  testUniverse.do_saveState();
});


/**
 * Since we currently don't really support composing HTML, we cram an HTML
 * message into the inbox so that we can reply to it.
 */
TD.commonCase('reply/forward html message', function(T, RT) {
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U', { realDate: true }),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true,
                              realAccountNeeded: 'append' }),
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
        '<style type="text/css">' +
        'p { margin: 0; }' +
        '</style>' +
        '<p>I am the reply to the quote below.</p>' +
        '<blockquote><p>I am the replied-to text!</p></blockquote>' +
        '</blockquote>',
        /* XXX when signatures get put back in/tested:
        '<pre class="moz-signature" cols="72">' +
        $accountcommon.DEFAULT_SIGNATURE +
        '</pre>',
        */
      bpartHtml =
        new $msggen.SyntheticPartLeaf(
          bstrHtml,  { contentType: 'text/html' });

  var uniqueSubject = makeRandomSubject();

  var msgDef = {
    subject: uniqueSubject,
    from: {name: TEST_PARAMS.name, address: TEST_PARAMS.emailAddress},
    messageId: makeRandomSubject().replace(/[: ]+/g, ''),
    bodyPart: bpartHtml,
    checkReply: {
      text: replyTextHtml,
      html: replyHtmlHtml,
    }
  };

  var inboxFolder = testAccount.do_useExistingFolderWithType('inbox', '');

  var inboxView = testAccount.do_openFolderView(
                    'inbox', inboxFolder, null, null,
                    { syncedToDawnOfTime: 'ignore' });

  testAccount.do_addMessagesToFolder(
    inboxFolder, function makeMessages() {
    var msgGen = new $msggen.MessageGenerator(testAccount._useDate);

    msgDef.age = { minutes: 1 };
    var synMsg = msgGen.makeMessage(msgDef);
      console.warn(synMsg.toMessageString());
    return [synMsg];
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
        expectedReplyBody.text.replace(/\n/g, '<br/>'),
        '</div>',
        expectedReplyBody.html,
      ].join('');
      eCheck.expect_namedValue('rep type', 'html');
      eCheck.expect_namedValue('rep', expectedHtmlRep);
    },
    // trigger the reply composer
    withMessage: function(header) {
      testAccount.getMessageBodyWithReps(header, function(body) {
        eCheck.namedValue('rep type', body.bodyReps[0].type);
        eCheck.namedValue('rep', body.bodyReps[0].content);
      });
    }
  });

  T.group('cleanup');
  // Make sure the append operation's success gets persisted; this is a testing
  // hack until we ensure that the operation log gets persisted more frequently.
  testUniverse.do_saveState();
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
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true,
                              realAccountNeeded: true }),
      eCheck = T.lazyLogger('messageCheck');


  var senderPair, toPairs, ccPairs;
  var msgNotIn, msgInTo, msgInCc, msgNoCc, msgNoTo;
  var testFolder = testAccount.do_createTestFolder(
    'test_compose_reply_all',
    function makeMessages() {
      var msgGen = new $msggen.MessageGenerator(testAccount._useDate);

      senderPair = msgGen.makeNameAndAddress();
      toPairs = msgGen.makeNamesAndAddresses(4);
      ccPairs = msgGen.makeNamesAndAddresses(4);
      var msgs = [];
      // 0: the sender is not already in the to/cc
      msgs.push(msgGen.makeMessage(msgNotIn = {
          from: senderPair, to: toPairs, cc: ccPairs, age: { hours: 1 }
        }));
      // 1: the sender is in the 'to' list
      msgs.push(msgGen.makeMessage(msgInTo = {
          from: senderPair, to: toPairs.concat([senderPair]), cc: ccPairs,
          age: { hours: 2 }
        }));
      // 2: the sender is in the 'cc' list
      msgs.push(msgGen.makeMessage(msgInCc = {
          from: senderPair, to: toPairs, cc: ccPairs.concat([senderPair]),
          age: { hours: 3 }
        }));
      // 3: no 'cc' list at all; sender not in list
      msgs.push(msgGen.makeMessage(msgNoCc = {
          from: senderPair, to: toPairs, cc: [],
          age: { hours: 4 }
        }));
      // 4: no 'to' list at all; sender not in list
      msgs.push(msgGen.makeMessage(msgNoTo = {
          from: senderPair, to: [], cc: ccPairs,
          age: { hours: 5 }
        }));
      return msgs;
    });
  var testView = testAccount.do_openFolderView('syncs', testFolder,
    { count: 5, full: 5, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
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
    eCheck.expect_namedValue('no-cc:cc', []);
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

TD.commonCase('bcc self', function(T, RT) {
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U', { realDate: true }),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true,
                              realAccountNeeded: true });

  var uniqueSubject = makeRandomSubject();

  var composer, eLazy = T.lazyLogger('check');
  // - open the folder
  var inboxFolder = testAccount.do_useExistingFolderWithType('inbox', ''),
      inboxView = testAccount.do_openFolderView(
        'inbox', inboxFolder, null, null,
        { syncedToDawnOfTime: 'ignore' }),
      sentFolder = testAccount.do_useExistingFolderWithType('sent', ''),
      sentView = testAccount.do_openFolderView(
        'sent', sentFolder, null, null,
        { syncedToDawnOfTime: 'ignore' }),
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

    composer.bcc.push({ name: 'Myself', address: TEST_PARAMS.emailAddress });
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

  // - verify sent folder contains message and the message has BCC header
  testAccount.do_waitForMessage(sentView, uniqueSubject, {
    expect: function() {
      __deviceStorageLogFunc = eLazy.namedValue.bind(eLazy);
      RT.reportActiveActorThisStep(eLazy);
      eLazy.expect_namedValue('subject', uniqueSubject);
      eLazy.expect_namedValue(
        'bcc',
        // IMAP (except gmail where we will error) can report BCC addresses,
        // but ActiveSync can't report BCC contents.
        TEST_PARAMS.type === 'imap' ?
          [{ name: 'Myself', address: TEST_PARAMS.emailAddress }] : null);
    },
    withMessage: function(header) {
      eLazy.namedValue('subject', header.subject);
      eLazy.namedValue('bcc', header.bcc);
    }
  }).timeoutMS = TEST_PARAMS.slow ? 30000 : 5000;

  // - see the new message, make sure it doesn't have a BCC header
  testAccount.do_waitForMessage(inboxView, uniqueSubject, {
    expect: function() {
      RT.reportActiveActorThisStep(eLazy);
      eLazy.expect_namedValue('bcc', null);
    },
    // trigger the reply composer
    withMessage: function(header) {
      eLazy.namedValue('bcc', header.bcc);
    },
  }).timeoutMS = TEST_PARAMS.slow ? 30000 : 5000;
});

}); // end define

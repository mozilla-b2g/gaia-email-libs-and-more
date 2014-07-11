/**
 * Test the composition process and our ability to properly display newly
 * received messages.
 *
 * IMPORTANT NOTE: There is no cheap way to get message-id and other threading
 * headers from ActiveSync.  To do that, we would need to fetch the MIME body
 * of the message (although we only need through the given header, though we
 * might not have an easy way to know where the headers stop, etc. etc.)
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
 * does because unit tests usually like determinism.)  This is required because
 * we potentially use a real Inbox which may have test detritus from previous
 * runs.  In that case, we don't want to be tricked by a previous test run's
 * values.
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
                            { universe: testUniverse }),
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
  const ATTACHMENT_SIZE = 2048;
  const attachmentData = [];
  for (var iData = 0; iData < ATTACHMENT_SIZE; iData++) {
    attachmentData.push(iData % 256);
  }

  T.action(testAccount, 'compose, save draft, attach blob', eLazy, function() {
    testAccount.expect_runOp(
      'saveDraft',
      { local: true, server: false, save: 'local' });
    testAccount.expect_runOp(
      'attachBlobToDraft',
      { local: true, server: false, flushBodyLocalSaves: 1 });
    eLazy.expect_event('attached');

    composer.to.push({ name: 'Myself', address: TEST_PARAMS.emailAddress });
    composer.subject = uniqueSubject;
    // (Prepend our text to whatever's already there.)
    composer.body.text = 'Antelope banana credenza.\n\nDialog excitement!' +
                         composer.body.text;

    // this implicitly triggers the saveDraft followed by the attachBlobToDraft
    composer.addAttachment({
      name: 'foo.png',
      blob: new Blob([new Uint8Array(attachmentData)], { type: 'image/png' }),
    }, function() {
      eLazy.event('attached');
      composer.die();
      composer = null;
    });
  });

  var lastDraftId;
  T.action('locate draft header, resume editing', eLazy, function() {
    eLazy.expect_namedValue('draft count', 1);
    eLazy.expect_namedValue('header subject', uniqueSubject);
    eLazy.expect_event('resumed');
    eLazy.expect_namedValue('draft subject', uniqueSubject);
    eLazy.expect_namedValue('draft text',
                            'Antelope banana credenza.\n\nDialog excitement!');
    eLazy.expect_namedValue('draft attachment count', 1);
    eLazy.expect_namedValue('draft attachment name', 'foo.png');
    eLazy.expect_namedValue('draft attachment type', 'image/png');
    eLazy.expect_namedValue('draft attachment size', ATTACHMENT_SIZE);

    eLazy.namedValue('draft count', localDraftsView.slice.items.length);
    var draftHeader = localDraftsView.slice.items[0];
    lastDraftId = draftHeader.id;
    eLazy.namedValue('header subject', draftHeader.subject);
    composer = draftHeader.editAsDraft(function() {
      eLazy.event('resumed');
      eLazy.namedValue('draft subject', composer.subject);
      eLazy.namedValue('draft text', composer.body.text);
      eLazy.namedValue('draft attachment count', composer.attachments.length);
      eLazy.namedValue('draft attachment name',
                       composer.attachments[0].name);
      eLazy.namedValue('draft attachment type',
                       composer.attachments[0].blob.type);
      eLazy.namedValue('draft attachment size',
                       composer.attachments[0].blob.size);
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
    testAccount.expect_runOp(
      'saveDraft',
      { local: true, server: false, save: 'local' });
    testAccount.expect_sendMessageWithOutbox('success');

    eLazy.expect_event('sent');
    composer.finishCompositionSendMessage();

    testUniverse.MailAPI.onbackgroundsendstatus = function(data) {
      if (data.state === 'success') {
        sentMessageId = data.messageId.slice(1, -1); // lose < > wrapping
        eLazy.event('sent');
      }
    };
  }).timeoutMS = TEST_PARAMS.slow ? 10000 : 5000;

  T.check('draft message deleted', eLazy, function() {
    eLazy.expect_namedValue('draft count', 0);
    // Our previous step's expectations did not / could not ensure that any
    // viewslice notifications in the pipeline were fully delivered.  Use a
    // roundtrip.
    testAccount.MailAPI.ping(function() {
      eLazy.namedValue('draft count', localDraftsView.slice.items.length);
    });
  });

  // - verify sent folder contents
  testAccount.do_waitForMessage(sentView, uniqueSubject, {
    expect: function() {
      // We are going to want to add some expectations in the withMessage case
      // so avoid early resolution of the account's logs.
      testAccount.eOpAccount.asyncEventsAreComingDoNotResolve();

      RT.reportActiveActorThisStep(testAccount.eJobDriver);
      RT.reportActiveActorThisStep(eLazy);
      RT.reportActiveActorThisStep(testStorage);
      eLazy.expect_namedValue('subject', uniqueSubject);
      // only IMAP exposes message-id's right now
      if (testAccount.type === 'imap') {
        eLazy.expect_namedValue('message-id', sentMessageId);
      }
      eLazy.expect_namedValue(
        'sent body text',
        'Antelope banana credenza.\n\nDialog excitement!');
      eLazy.expect_namedValue(
        'attachments',
        [{
          filename: 'foo.png',
          mimetype: (testAccount.type !== 'pop3') ?
                      'image/png' : 'application/x-gelam-no-download',
          // there is some guessing/rounding involved
          sizeEstimateInBytes: testAccount.exactAttachmentSizes ?
            ATTACHMENT_SIZE : ATTACHMENT_SIZE - 1,
          isDownloadable: (testAccount.type !== 'pop3')
         }]);
      // For POP3 we discard the sent attachments.
      if (testAccount.type !== 'pop3') {
        testAccount.eJobDriver.expect_savedAttachment(
            'sdcard', 'image/png', ATTACHMENT_SIZE);
        // adding a file sends created and modified
        testStorage.expect_created('foo.png');
        testStorage.expect_modified('foo.png');
        eLazy.expect_namedValue(
          'attachment[0].size', ATTACHMENT_SIZE);
        eLazy.expect_namedValue(
          'attachment[0].data', attachmentData.concat());
      }
    },
    withMessage: function(header) {
      if (testAccount.type !== 'pop3') {
        // getBody({ withBodyReps }) causes this.
        testAccount.expect_runOp(
          'downloadBodyReps',
          { local: false, server: true, save: 'server' });
        // att.download causes this
        testAccount.expect_runOp(
          'download',
          // the local stuff is because it's a no-op.  we should remove.
          { local: true, server: true, save: 'server',
            flushBodyServerSaves: 1 });
      }
      // okay, we now added all the expectations on the test account.
      testAccount.eOpAccount.asyncEventsAllDoneDoResolve();

      eLazy.namedValue('subject', header.subject);
      if (testAccount.type === 'imap') {
        eLazy.namedValue('message-id', header.guid);
      }
      header.getBody({ withBodyReps: true }, function(body) {
        eLazy.namedValue('sent body text', body.bodyReps[0].content[1]);
        var attachments = [];
        body.attachments.forEach(function(att, iAtt) {
          attachments.push({
            filename: att.filename,
            mimetype: att.mimetype,
            sizeEstimateInBytes: att.sizeEstimateInBytes,
            isDownloadable: att.isDownloadable
          });
          if (testAccount.type === 'pop3')
            return;
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
      // We are going to want to add some expectations in the withMessage case
      // so avoid early resolution of the account's logs.
      testAccount.eOpAccount.asyncEventsAreComingDoNotResolve();

      RT.reportActiveActorThisStep(eLazy);
      eLazy.expect_namedValue(
        'received body text',
        'Antelope banana credenza.\n\nDialog excitement!');
      if (testAccount.type !== 'activesync')
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
      if (testAccount.type !== 'activesync')
        eLazy.expect_namedValue('references', '<' + sentMessageId + '>');
      else
        eLazy.expect_namedValue('references', '');
      eLazy.expect_namedValue('body text', expectedReplyBody.text);
      eLazy.expect_namedValue('body html', expectedReplyBody.html);
    },
    // trigger the reply composer
    withMessage: function(header) {
      if (testAccount.type !== 'pop3') {
        testAccount.expect_runOp(
          'downloadBodyReps',
          { local: false, server: true, save: 'server' });
      }
      // okay, we now added all the expectations on the test account.
      testAccount.eOpAccount.asyncEventsAllDoneDoResolve();

      header.getBody({ withBodyReps: true }, function(body) {
        eLazy.namedValue('received body text', body.bodyReps[0].content[1]);
        if (testAccount.type !== 'activesync')
          eLazy.namedValue('source message-id', header.guid);
        replyComposer = header.replyToMessage('sender', function() {
          eLazy.event('reply setup completed');
          eLazy.namedValue('to', replyComposer.to);
          eLazy.namedValue('subject', replyComposer.subject);
          eLazy.namedValue('references', replyComposer._references);
          eLazy.namedValue('body text', replyComposer.body.text);
          eLazy.namedValue('body html', replyComposer.body.html);
        });
      });
    },
  }).timeoutMS = TEST_PARAMS.slow ? 30000 : 5000;

  // - complete and send the reply
  var replySentDate, replyMessageId, replyReferences;
  T.action(testAccount, 'reply', eLazy, function() {
    testAccount.expect_runOp(
      'saveDraft',
      { local: true, server: false, save: 'local' });
    testAccount.expect_sendMessageWithOutbox('sucesss');
    eLazy.expect_event('sent');

    replyComposer.body.text = expectedReplyBody.text =
      'This bit is new!' + replyComposer.body.text;

    replyComposer.finishCompositionSendMessage();

    testUniverse.MailAPI.onbackgroundsendstatus = function(data) {
      if (data.state === 'success') {
        replySentDate = new Date(data.sentDate);
        replyMessageId = data.messageId.slice(1, -1); // lose < > wrapping
        replyReferences = [sentMessageId];
        eLazy.event('sent');
      }
    };
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

      if (testAccount.type === 'activesync') {
        eLazy.expect_event('ActiveSync is bad for threading');
      } else {
        eLazy.expect_namedValue('replied message-id', replyMessageId);
        eLazy.expect_namedValue('replied references', replyReferences);
      }
    },
    withMessage: function(header) {
      replyHeader = header;
      if (testAccount.type === 'activesync') {
        eLazy.event('ActiveSync is bad for threading');
      } else {
        eLazy.namedValue('replied message-id', header.guid);
        header.getBody(function(repliedBody) {
          eLazy.namedValue('replied references', repliedBody._references);
        });
      }
    },
  }).timeoutMS = TEST_PARAMS.slow ? 30000 : 5000;
  T.group('check forward generation logic');
  T.check('check forward', eLazy, testAccount.eOpAccount, function() {
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

    // performing the forward will compel a download of the body
    if (testAccount.type !== 'pop3') {
      testAccount.expect_runOp(
        'downloadBodyReps',
        { local: false, server: true, save: 'server' });
    }


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
  T.action(testAccount, 'reply to the reply', eLazy, function() {
    testAccount.expect_runOp(
      'saveDraft',
      { local: true, server: false, save: 'local' });
    testAccount.expect_sendMessageWithOutbox('success');
    eLazy.expect_event('sent');

    var secondReplyComposer = replyHeader.replyToMessage('sender', function() {
      secondReplyComposer.body.text = expectedReplyBody.text =
        'And now this bit is new.' + replyComposer.body.text;
      // XXX hack to let us match by subject, but we should just modify/augment
      // do_waitForMessage to support matching on message-id since we surface
      // that as the 'guid'.
      secondReplyComposer.subject += '[2]';

      secondReplyComposer.finishCompositionSendMessage();

      testUniverse.MailAPI.onbackgroundsendstatus = function(data) {
        if (data.state === 'success') {
          secondReplySentDate = new Date(data.sentDate);
          secondReplyMessageId = data.messageId.slice(1, -1); // lose <>
          secondReplyReferences = replyReferences.concat([replyMessageId]);
          eLazy.event('sent');
        }
      };
    });
  });
  testAccount.do_waitForMessage(inboxView, 'Re: ' + uniqueSubject + '[2]', {
    expect: function() {
      RT.reportActiveActorThisStep(eLazy);

      if (testAccount.type !== 'activesync') {
        eLazy.expect_namedValue('replied message-id', secondReplyMessageId);
        eLazy.expect_namedValue('replied references', secondReplyReferences);
      }
      else {
        eLazy.expect_event('ActiveSync is bad for threading');
      }
    },
    withMessage: function(header) {
      replyHeader = header;
      if (testAccount.type !== 'activesync') {
        eLazy.namedValue('replied message-id', header.guid);
        header.getBody(function(body) {
          eLazy.namedValue('replied references', body._references);
        });
      }
      else {
        eLazy.event('ActiveSync is bad for threading');
      }
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
        '<blockquote ' +
        // ActiveSync does not have the message-id so we can't include the
        // cite stuff.  Note that if we do start sourcing the message id, then
        // this test will break (and we can fix it) because inclusion is based
        // on posession of the message-id and not hardcoded to account type.
        (testAccount.type !== 'activesync' ? 'cite="mid:$MESSAGEID$" ' : '') +
        'type="cite">' +
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
    var synMsg = msgGen.makeMessage(msgDef);
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
  T.action(testAccount, eCheck,
           'reply to HTML message', msgDef.name, function() {
    // POP3 performs its snippet fetching as part of the initial sync; since the
    // bodies are tiny, the message is downloaded in its entirety.
    if (testAccount.type !== 'pop3') {
      testAccount.expect_runOp(
        'downloadBodyReps',
        { local: false, server: true, save:'server' });
    }
    testAccount.expect_runOp(
      'saveDraft',
      { local: true, server: false, save: 'local' });
    testAccount.expect_sendMessageWithOutbox('success', 'conn');

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

      composer.finishCompositionSendMessage();

      testUniverse.MailAPI.onbackgroundsendstatus = function(data) {
        if (data.state === 'success') {
          eCheck.event('sent');
        }
      };
    });
  });
  testAccount.do_waitForMessage(inboxView, 'Re: ' + uniqueSubject, {
    expect: function() {
      // We are going to want to add some expectations in the withMessage case
      // so avoid early resolution of the account's logs.
      testAccount.eOpAccount.asyncEventsAreComingDoNotResolve();

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
      if (testAccount.type !== 'pop3') {
        testAccount.expect_runOp(
          'downloadBodyReps',
          { local: false, server: true, save: 'server' });
      }
      // okay, we now added all the expectations on the test account.
      testAccount.eOpAccount.asyncEventsAllDoneDoResolve();


      header.getBody({ withBodyReps: true }, function(body) {
        eCheck.namedValue('rep type', body.bodyReps[0].type);
        eCheck.namedValue('rep', body.bodyReps[0].content);
        body.die();
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
                            { universe: testUniverse, restored: true }),
      eCheck = T.lazyLogger('messageCheck');

  var TEST_PARAMS = RT.envOptions;

  var youPair = {
    name: TEST_PARAMS.name,
    address: TEST_PARAMS.emailAddress
  };
  var senderPair, toPairs, ccPairs;
  var msgNotIn, msgInTo, msgInCc, msgNoCc, msgNoTo, msgYouTo;
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
      // 5: you (the person replying) are in the 'to' list
      msgs.push(msgGen.makeMessage(msgYouTo = {
          from: senderPair, to: toPairs.concat([youPair]), cc: ccPairs,
          age: { hours: 6 }
        }));
      return msgs;
    });
  var testView = testAccount.do_openFolderView('syncs', testFolder,
    { count: 6, full: 6, flags: 0, change: 0, deleted: 0,
      filterType: 'none' },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  T.action(eCheck, 'reply composer variants', function() {
    var slice = testView.slice;
    var headerNotIn = slice.items[0],
        headerInTo = slice.items[1],
        headerInCc = slice.items[2],
        headerNoCc = slice.items[3],
        headerNoTo = slice.items[4],
        headerYouTo = slice.items[5];

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

    eCheck.expect_namedValue('you-to:to', [senderPair].concat(toPairs));
    eCheck.expect_namedValue('you-to:cc', msgYouTo.cc);
    var composerYouTo = headerYouTo.replyToMessage('all', function() {
      eCheck.namedValue('you-to:to', composerYouTo.to);
      eCheck.namedValue('you-to:cc', composerYouTo.cc);
    });
  });
  testAccount.do_closeFolderView(testView);
});

TD.commonCase('bcc self', function(T, RT) {
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U', { realDate: true }),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true });

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

  T.action(testAccount, 'send', eLazy, function() {
    testAccount.expect_runOp(
      'saveDraft',
      { local: true, server: false, save: 'local' });
    testAccount.expect_sendMessageWithOutbox('success');

    eLazy.expect_event('sent');
    eLazy.expect_event('appended');

    composer.bcc.push({ name: 'Myself', address: TEST_PARAMS.emailAddress });
    composer.subject = uniqueSubject;
    composer.body.text = 'Antelope banana credenza.\n\nDialog excitement!';

    composer.finishCompositionSendMessage();

    testUniverse.MailAPI.onbackgroundsendstatus = function(data) {
      if (data.state === 'success') {
        eLazy.event('sent');
        MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
          eLazy.event('appended');
        });
      }
    };
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
        TEST_PARAMS.type !== 'activesync' ?
          [{ name: 'Myself', address: TEST_PARAMS.emailAddress,
             contactId: null }] : null);
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

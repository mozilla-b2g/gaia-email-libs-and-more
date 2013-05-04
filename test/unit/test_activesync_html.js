/**
 * Test our processing of HTML messages and messages with attachments from
 * ActiveSync.
 **/

define(['rdcommon/testcontext', './resources/th_main',
        './resources/th_activesync_server',
        './resources/messageGenerator',
        'wbxml', 'activesync/codepages',
        'exports'],
       function($tc, $th_imap, $th_as_server, $msggen, $wbxml, $ascp, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_activesync_html' }, null,
  [$th_imap.TESTHELPER, $th_as_server.TESTHELPER], ['app']);

TD.commonCase('folder sync', function(T) {
  const FilterType = $ascp.AirSync.Enums.FilterType;

  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testServer = T.actor('testActiveSyncServer', 'S',
                           { universe: testUniverse }),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, server: testServer }),
      eCheck = T.lazyLogger('messageCheck');

  var fullSyncFolder = testAccount.do_createTestFolder(
    'test_html_messages',
    { count: 0 });

  var bstrTrivialHtml =
        '<html><head></head><body>I am HTML! Woo!</body></html>',
      bstrSanitizedTrivialHtml =
        'I am HTML! Woo!',
      bpartTrivialHtml = new $msggen.SyntheticPartLeaf(
        bstrTrivialHtml, {contentType: 'text/html'}),

      bstrLimitedHtml =
        '<div>I <form>am <span>HTML!</span></form></div>',
      bstrSanitizedLimitedHtml =
        '<div>I am <span>HTML!</span></div>',
      bpartLimitedHtml =
        new $msggen.SyntheticPartLeaf(
          bstrLimitedHtml, { contentType: 'text/html' }),

      bstrLongTextHtml =
        '<p>This is a very long message that wants to be snippeted to a ' +
        'reasonable length that is reasonable and not unreasonable.  It is ' +
        'neither too long nor too short.  Not too octogonal nor hexagonal. ' +
        'It is just right.</p>',
      bpartLongTextHtml =
        new $msggen.SyntheticPartLeaf(
          bstrLongTextHtml, { contentType: 'text/html' }),

      bstrStyleHtml =
        '<style type="text/css">' +
        'p { color: red; background-color: blue;' +
        ' background-image: url("http://example.com/danger.png"); }\n' +
        '@font-face { font-family: "Bob";' +
        ' src: url("http://example.com/bob.woff"); }\n' +
        'blockquote { color: pink; }' +
        '</style>I am the <span>a<span>ctua</span>l</span> content.',
      bstrSanitizedStyleHtml =
        '<style type="text/css">' +
        'p { color: red; background-color: blue; }\n' +
        'blockquote { color: pink; }' +
        '</style>I am the <span>a<span>ctua</span>l</span> content.',
      snipStyleHtml = 'I am the actual content.',
      bpartStyleHtml =
        new $msggen.SyntheticPartLeaf(
          bstrStyleHtml, { contentType: 'text/html' }),

      bstrImageHtml =
        'Have an image! <img src="cid:waffles@mozilla.com">',
      bstrSanitizedImageHtml =
        'Have an image! <img cid-src="waffles@mozilla.com" ' +
        'class="moz-embedded-image"/>',
      bpartImageHtml =
        new $msggen.SyntheticPartLeaf(
          bstrImageHtml, { contentType: 'text/html' });


  var testMessages = [
    {
      name: 'text/html trivial (sanitized to just text)',
      bodyPart: bpartTrivialHtml,
      checkBody: bstrSanitizedTrivialHtml,
    },
    {
      name: 'text/html limited (sanitization leaves some behind)',
      bodyPart: bpartLimitedHtml,
      checkBody: bstrSanitizedLimitedHtml,
    },
    {
      name: 'text/html long string for quoting',
      bodyPart: bpartLongTextHtml,
      checkBody: bstrLongTextHtml,
      checkSnippet:
        'This is a very long message that wants to be snippeted to a ' +
        'reasonable length that is reasonable and',
    },
    {
      name: 'text/html w/style tag',
      bodyPart: bpartStyleHtml,
      checkBody: bstrSanitizedStyleHtml,
      checkSnippet: snipStyleHtml,
    },
    {
      name: 'text/html with one attachment',
      bodyPart: bpartTrivialHtml,
      checkBody: bstrSanitizedTrivialHtml,
      attachments: [
        { filename: 'pancakes.jpg', contentType: 'image/jpeg',
          body: "I'm an attachment!" },
      ],
    },
    {
      name: 'text/html with two attachments',
      bodyPart: bpartTrivialHtml,
      checkBody: bstrSanitizedTrivialHtml,
      attachments: [
        { filename: 'eggs.jpg', contentType: 'image/jpeg',
          body: "I'm an attachment!" },
        { filename: 'toast.jpg', contentType: 'image/jpeg',
          body: 'So am I!' },
      ],
    },
    {
      name: 'text/html with embedded image',
      bodyPart: bpartImageHtml,
      checkBody: bstrSanitizedImageHtml,
      attachments: [
        { filename: 'waffles.png', contentType: 'image/png',
          contentId: 'waffles@mozilla.com',
          body: 'pretend this is an image' },
      ],
    },
    {
      name: 'text/html with embedded image and two attachments',
      bodyPart: bpartImageHtml,
      checkBody: bstrSanitizedImageHtml,
      attachments: [
        { filename: 'bacon.jpg', contentType: 'image/jpeg',
          body: "I'm an attachment!" },
        { filename: 'sausage.jpg', contentType: 'image/jpeg',
          body: 'So am I!' },
        { filename: 'orange-juice.png', contentType: 'image/png',
          contentId: 'oj@mozilla.com',
          body: 'pretend this is an image' },
      ],
    },
  ];

  for (var i = 0; i < testMessages.length; i++) {
    var msgDef = testMessages[i];
    msgDef.age = { days: 1, hours: i };
    testAccount.do_addMessageToFolder(fullSyncFolder, msgDef);
  }

  var folderView = testAccount.do_openFolderView(
    'syncs', fullSyncFolder,
    { count: testMessages.length, full: testMessages.length, flags: 0,
      deleted: 0, filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false }
  );
  // -- check each message in its own group
  testMessages.forEach(function checkMessage(msgDef, iMsg) {
    T.group(msgDef.name);

    var body, hasRelatedParts = false, hasAttachments = false;
    // Decide if we should perform steps to download related parts and/or
    // attachments. This is just to make the logs cleaner.
    if ('attachments' in msgDef) {
      hasRelatedParts = msgDef.attachments.some(function(x) {
        return !!x.contentId;
      });
      hasAttachments = msgDef.attachments.some(function(x) {
        return !x.contentId;
      });
    }

    T.check(eCheck, 'check body', function() {
      eCheck.expect_namedValue('body', msgDef.checkBody);

      if (msgDef.checkSnippet)
        eCheck.expect_namedValue('snippet', msgDef.checkSnippet);
      if ('attachments' in msgDef) {
        for (var i = 0; i < msgDef.attachments.length; i++) {
          var prefix = msgDef.attachments[i].contentId ?
                       'relatedpart' : 'attachment';
          eCheck.expect_namedValue(prefix + '-name',
                                   msgDef.attachments[i].filename);
          eCheck.expect_namedValue(prefix + '-size',
                                   msgDef.attachments[i].body.length);
          eCheck.expect_namedValue(prefix + '-contenttype-guess',
                                   msgDef.attachments[i].contentType);
        }
      }

      var header = folderView.slice.items[iMsg];
      testAccount.getMessageBodyWithReps(
        header,
        function(_body) {
          body = _body;
          eCheck.namedValue('body', body.bodyReps[0].content);
          if (msgDef.checkSnippet)
            eCheck.namedValue('snippet', header.snippet);

          if (body.attachments && body.attachments.length) {
            for (var i = 0; i < body.attachments.length; i++) {
              eCheck.namedValue('attachment-name',
                                body.attachments[i].filename);
              eCheck.namedValue('attachment-size',
                                body.attachments[i].sizeEstimateInBytes);
              eCheck.namedValue('attachment-contenttype-guess',
                                body.attachments[i].mimetype);
            }
          }
          if (body._relatedParts && body._relatedParts.length) {
            for (var i = 0; i < body._relatedParts.length; i++) {
              eCheck.namedValue('relatedpart-name',
                                body._relatedParts[i].name);
              eCheck.namedValue('relatedpart-size',
                                body._relatedParts[i].sizeEstimate);
              eCheck.namedValue('relatedpart-contenttype-guess',
                                body._relatedParts[i].type);
            }
          }
        },
        null,
        function mainThreadFunc(arg, fancyBody, sendResults) {
          var displayDoc = null, displayElem = null;

          displayDoc = document.implementation.createHTMLDocument('');
          displayElem = displayDoc.body;
          displayElem.innerHTML = fancyBody.bodyReps[0].content;

          sendResults(fancyBody.checkForExternalImages(displayElem));
        },
        function withMainThreadResults(results) {}
      );
    });

    if (hasRelatedParts) {
      T.check(eCheck, 'download embedded images', function() {
        eCheck.expect_event('downloaded');
        if ('attachments' in msgDef) {
          for (var i = 0; i < msgDef.attachments.length; i++) {
            if (msgDef.attachments[i].contentId) {
              eCheck.expect_namedValue('relatedpart', true);
              eCheck.expect_namedValue('relatedpart-contenttype',
                                       msgDef.attachments[i].contentType);
            }
          }
        }

        body.downloadEmbeddedImages(function() {
          eCheck.event('downloaded');
          for (var i = 0; i < body._relatedParts.length; i++) {
            eCheck.namedValue('relatedpart', !!body._relatedParts[i].file);
            eCheck.namedValue('relatedpart-contenttype',
                              body._relatedParts[i].type);
          }
        });
      });
    }

    if (hasAttachments) {
      T.check(eCheck, 'download attachments', function() {
        for (var i = 0; i < body.attachments.length; i++) {
          eCheck.expect_event('downloaded');
          eCheck.expect_namedValue('attachment', true);

          body.attachments[i].download((function(attachment) {
            eCheck.event('downloaded');
            eCheck.namedValue('attachment', !!attachment._file);
          }).bind(this, body.attachments[i]));
        }
      });
    }

    T.action(eCheck, 'kill body', function() {
      body.die();
      body = null;
    });
  });

  T.group('cleanup');
  testAccount.do_closeFolderView(folderView);
});

}); // end define

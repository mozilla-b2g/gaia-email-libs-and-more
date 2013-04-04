/**
 * Test the more complex parts of HTML message handling, specifically:
 * - multipart/related messages with embedded images
 * - messages with externally referenced images
 * - messages with external links
 **/

define(['rdcommon/testcontext', 'mailapi/testhelper',
        './resources/messageGenerator', 'exports'],
       function($tc, $th_imap, $msggen, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_mail_html' }, null, [$th_imap.TESTHELPER], ['app']);


TD.commonCase('embedded and remote images', function(T) {
  // -- pieces
  var
  // - multipart/related text/html with embedded images, remote images, links
      bstrFancyHtml =
        '<html><head></head><body>image 1: <img src="cid:part1.foo@bar.com">' +
        ' image 2: <img src="cid:part2.foo@bar.com">' +
        ' image 3: <img src="http://example.com/foo.png">' +
        ' <a id="thelink"></a>' + //
        ' <a href="http://example.com/bar.html">link</a></body></html>',
      bstrSanitizedFancyHtml =
        'image 1: <img cid-src="part1.foo@bar.com"' +
        ' class="moz-embedded-image"/> ' +
        'image 2: <img cid-src="part2.foo@bar.com"' +
        ' class="moz-embedded-image"/> ' +
        'image 3: <img ext-src="http://example.com/foo.png"' +
        ' class="moz-external-image"/> ' +
        '<a id="thelink"></a> ' +
        '<a ext-href="http://example.com/bar.html" class="moz-external-link">' +
        'link</a>',
      bpartFancyHtml =
        new $msggen.SyntheticPartLeaf(
          bstrFancyHtml, { contentType: 'text/html' }),
      relImage_1 = {
          contentType: 'image/png',
          encoding: 'base64', charset: null, format: null,
          contentId: 'part1.foo@bar.com',
          body: 'cGFydDE=' // "part1" in base64
        },
      size_1 = 5,
      partRelImage_1 = new $msggen.SyntheticPartLeaf(relImage_1.body,
                                                     relImage_1),
      relImage_2 = {
          contentType: 'image/png',
          encoding: 'base64', charset: null, format: null,
          contentId: 'part2.foo@bar.com',
          body: 'eWF5Mg===' // "yay2" in base64
        },
      size_2 = 4,
      partRelImage_2 = new $msggen.SyntheticPartLeaf(relImage_2.body,
                                                     relImage_2),
      bpartRelatedHtml =
        new $msggen.SyntheticPartMultiRelated(
          [bpartFancyHtml, partRelImage_1, partRelImage_2]);

  // -- full definitions and expectations
  var testMessages = [
    {
      name: 'fancy html direct',
      bodyPart: bpartRelatedHtml,
    },
  ];
  T.group('setup');
  var TU1 = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: TU1 }),
      eCheck = T.lazyLogger('messageCheck');

  // -- create the folder, append the messages
  var testFolder = testAccount.do_createTestFolder(
    'test_mail_html', function makeMessages() {
    var messageAppends = [],
        msgGen = new $msggen.MessageGenerator(TU1._useDate);

    for (var i = 0; i < testMessages.length; i++) {
      var msgDef = testMessages[i];
      msgDef.age = { days: 1, hours: i };
      var synMsg = msgGen.makeMessage(msgDef);
      messageAppends.push({
        date: synMsg.date,
        headerInfo: {
          subject: synMsg.subject,
        },
        messageText: synMsg.toMessageString(),
      });
    }

    return messageAppends;
  });
  // -- open the folder
  var folderView = testAccount.do_openFolderView(
    'syncs', testFolder,
    { count: testMessages.length, full: testMessages.length, flags: 0,
      deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  // -- check each message in its own step
  // - fancy html
  var idxFancy = 0, fancyHeader = null, fancyBody = null;

  T.check(eCheck, 'get fancy body', function() {
    eCheck.expect_event('got body');
    eCheck.expect_namedValue('bodyReps.length', 1);
    eCheck.expect_namedValue('bodyReps[0].type', 'html');
    eCheck.expect_namedValue('bodyReps[0].content', bstrSanitizedFancyHtml);
    eCheck.expect_namedValue('embeddedImageCount', 2);
    eCheck.expect_namedValue('embeddedImagesDownloaded', false);
    eCheck.expect_namedValue('checkForExternalImages', true);
    fancyHeader = folderView.slice.items[idxFancy];

    // the bodyReps may not be loaded at this point so we use
    // getMessageBodyWithReps to ensure that they are downloaded...
    testAccount.getMessageBodyWithReps(
      fancyHeader,
      function(body) {
        fancyBody = body;
        eCheck.event('got body');
        eCheck.namedValue('bodyReps.length', fancyBody.bodyReps.length);
        eCheck.namedValue('bodyReps[0].type', fancyBody.bodyReps[0].type);
        eCheck.namedValue('bodyReps[0].content', fancyBody.bodyReps[0].content);
        eCheck.namedValue('embeddedImageCount', fancyBody.embeddedImageCount);
        eCheck.namedValue('embeddedImagesDownloaded',
                          fancyBody.embeddedImagesDownloaded);
      },
      null,
      function mainThreadFunc(arg, fancyBody, sendResults) {
        var displayDoc = null, displayElem = null;

        displayDoc = document.implementation.createHTMLDocument('');
        displayElem = displayDoc.body;
        displayElem.innerHTML = fancyBody.bodyReps[0].content;

        sendResults(fancyBody.checkForExternalImages(displayElem));
      },
      function withMainThreadResults(results) {
        eCheck.namedValue('checkForExternalImages', results);
      });
  });
  // (We could verify the HTML rep prior to any transforms, but we already
  // verified the string rep of the HTML.)
  T.action(eCheck, 'download embedded images', function() {
    eCheck.expect_event('downloaded');
    eCheck.expect_namedValue('non-null relpart 0', true);
    eCheck.expect_namedValue('non-null relpart 1', true);

    testAccount.expect_runOp('download',
                             { local: true, server: true, save: 'server' });

    fancyBody.downloadEmbeddedImages(function() {
      eCheck.event('downloaded');
      eCheck.namedValue('non-null relpart 0',
                        !!fancyBody._relatedParts[0].file);
      eCheck.namedValue('non-null relpart 1',
                        !!fancyBody._relatedParts[1].file);
      fancyBody.die();
      fancyBody = null;
    });
  });
  T.check(eCheck, 'show embedded and external images', function() {
    // XXX We used to generate fake URLs ourselves; we would ideally use an XHR
    // to just fetch from the URL to load its content to make sure it's doing
    // the right thing.
    eCheck.expect_namedValue('image 0 has src', true);
    eCheck.expect_namedValue('image 1 has src', true);
    // the transform should not affect the external image
    eCheck.expect_namedValue('image 2 has src', null);

    eCheck.expect_namedValue('image 0 has src', true);
    eCheck.expect_namedValue('image 1 has src', true);
    eCheck.expect_namedValue('image 2 has src', 'http://example.com/foo.png');

    testAccount.getMessageBodyWithReps(
      fancyHeader,
      function(body) {
        body.die();
      },
      null,
      function mainThreadFunc(arg, fancyBody, sendResults) {
        var displayDoc = null, displayElem = null;

        displayDoc = document.implementation.createHTMLDocument('');
        displayElem = displayDoc.body;
        displayElem.innerHTML = fancyBody.bodyReps[0].content;

        fancyBody.showEmbeddedImages(displayElem);
        var imgs = displayElem.querySelectorAll('img');

        var results = {
          afterEmbedded: [
            imgs[0].getAttribute('src'),
            imgs[1].getAttribute('src'),
            imgs[2].getAttribute('src')
          ],
          afterExternal: null
        };

        fancyBody.showExternalImages(displayElem);
        imgs = displayElem.querySelectorAll('img');

        results.afterExternal = [
          imgs[0].getAttribute('src'),
          imgs[1].getAttribute('src'),
          imgs[2].getAttribute('src')
        ];

        sendResults(results);
      },
      function withMainThreadResults(results) {
        eCheck.namedValue('image 0 has src', !!results.afterEmbedded[0]);
        eCheck.namedValue('image 1 has src', !!results.afterEmbedded[1]);
        eCheck.namedValue('image 2 has src', results.afterEmbedded[2]);

        eCheck.namedValue('image 0 has src', !!results.afterExternal[0]);
        eCheck.namedValue('image 1 has src', !!results.afterExternal[1]);
        eCheck.namedValue('image 2 has src', results.afterExternal[2]);
      });
  });
  T.check(eCheck, 're-get body, verify embedded images are still there',
          function() {
    eCheck.expect_event('got body');
    eCheck.expect_namedValue('bodyReps.length', 1);
    eCheck.expect_namedValue('bodyReps[0].type', 'html');
    eCheck.expect_namedValue('bodyReps[0].content', bstrSanitizedFancyHtml);
    eCheck.expect_namedValue('embeddedImageCount', 2);
    eCheck.expect_namedValue('embeddedImagesDownloaded', true);
    eCheck.expect_namedValue('checkForExternalImages', true);
    eCheck.expect_namedValue('image 0 has src', true);
    eCheck.expect_namedValue('image 1 has src', true);
    // the transform should not affect the external image
    eCheck.expect_namedValue('image 2 has src', null);

    testAccount.getMessageBodyWithReps(
      fancyHeader,
      function(body) {
        fancyBody = body;
        eCheck.event('got body');
        eCheck.namedValue('bodyReps.length', fancyBody.bodyReps.length);
        eCheck.namedValue('bodyReps[0].type', fancyBody.bodyReps[0].type);
        eCheck.namedValue('bodyReps[0].content', fancyBody.bodyReps[0].content);
        eCheck.namedValue('embeddedImageCount', fancyBody.embeddedImageCount);
        eCheck.namedValue('embeddedImagesDownloaded',
                          fancyBody.embeddedImagesDownloaded);
        body.die();
      },
      null,
      function mainThreadFunc(arg, fancyBody, sendResults) {
        var displayDoc = null, displayElem = null;

        displayDoc = document.implementation.createHTMLDocument('');
        displayElem = displayDoc.body;
        displayElem.innerHTML = fancyBody.bodyReps[0].content;

        fancyBody.showEmbeddedImages(displayElem);
        var imgs = displayElem.querySelectorAll('img');

        sendResults({
          externalImages: fancyBody.checkForExternalImages(displayElem),
          imageSources: [
            imgs[0].getAttribute('src'),
            imgs[1].getAttribute('src'),
            imgs[2].getAttribute('src')
          ]
        });
      },
      function withMainThreadResults(results) {
        eCheck.namedValue('checkForExternalImages', results.externalImages);
        eCheck.namedValue('image 0 has src', !!results.imageSources[0]);
        eCheck.namedValue('image 1 has src', !!results.imageSources[1]);
        eCheck.namedValue('image 2 has src', results.imageSources[2]);
      });
  });

  T.group('unclean account shutdown');
  TU1.do_shutdown();

  T.group('reload universe');
  var TU2 = T.actor('testUniverse', 'U2', { old: TU1 });
  var TA2 = T.actor('testAccount', 'A2',
                    { universe: TU2, restored: true });

  T.group('verify images persisted');
  var testFolder2 = TA2.do_useExistingFolder(
                      'test_mail_html', '#2', testFolder);

  var folderView2 = TA2.do_openFolderView(
    'syncs', testFolder2,
    { count: testMessages.length, full: 0, flags: testMessages.length,
      deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  // THIS IS COPY AND PASTE FROM ABOVE EXCEPT FOR fancyHeader reestablishment
  T.check(eCheck, 're-get body, verify embedded images are still there',
          function() {
    eCheck.expect_event('got body');
    eCheck.expect_namedValue('bodyReps.length', 1);
    eCheck.expect_namedValue('bodyReps[0].type', 'html');
    eCheck.expect_namedValue('bodyReps[0].content', bstrSanitizedFancyHtml);
    eCheck.expect_namedValue('embeddedImageCount', 2);
    eCheck.expect_namedValue('embeddedImagesDownloaded', true);
    eCheck.expect_namedValue('checkForExternalImages', true);
    eCheck.expect_namedValue('image 0 has src', true);
    eCheck.expect_namedValue('image 1 has src', true);
    // the transform should not affect the external image
    eCheck.expect_namedValue('image 2 has src', null);

    fancyHeader = folderView2.slice.items[idxFancy];
    TA2.getMessageBodyWithReps(
      fancyHeader,
      function(body) {
        fancyBody = body;
        eCheck.event('got body');
        eCheck.namedValue('bodyReps.length', fancyBody.bodyReps.length);
        eCheck.namedValue('bodyReps[0].type', fancyBody.bodyReps[0].type);
        eCheck.namedValue('bodyReps[0].content', fancyBody.bodyReps[0].content);
        eCheck.namedValue('embeddedImageCount', fancyBody.embeddedImageCount);
        eCheck.namedValue('embeddedImagesDownloaded',
                          fancyBody.embeddedImagesDownloaded);
        body.die();
      },
      null,
      function mainThreadFunc(arg, fancyBody, sendResults) {
        var displayDoc = null, displayElem = null;

        displayDoc = document.implementation.createHTMLDocument('');
        displayElem = displayDoc.body;
        displayElem.innerHTML = fancyBody.bodyReps[0].content;

        fancyBody.showEmbeddedImages(displayElem);
        var imgs = displayElem.querySelectorAll('img');

        sendResults({
          externalImages: fancyBody.checkForExternalImages(displayElem),
          imageSources: [
            imgs[0].getAttribute('src'),
            imgs[1].getAttribute('src'),
            imgs[2].getAttribute('src')
          ]
        });
      },
      function withMainThreadResults(results) {
        eCheck.namedValue('checkForExternalImages', results.externalImages);
        eCheck.namedValue('image 0 has src', !!results.imageSources[0]);
        eCheck.namedValue('image 1 has src', !!results.imageSources[1]);
        eCheck.namedValue('image 2 has src', results.imageSources[2]);
      });
  });

  T.group('cleanup');
  TA2.do_closeFolderView(folderView2);
});

}); // end define

/**
 * Test the more complex parts of HTML message handling, specifically:
 * - multipart/related messages with embedded images
 * - messages with externally referenced images
 * - messages with external links
 **/
define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var $msggen = require('./resources/messageGenerator');

return new LegacyGelamTest('embedded and remote images', function(T) {
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
          disposition: 'inline',
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
  var TU1 = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A',
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
      messageAppends.push(msgGen.makeMessage(msgDef));
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

  var hasFakePart = (testAccount.type === 'pop3');

  T.check(eCheck, 'get fancy body', function() {
    if (testAccount.type !== 'pop3') {
      testAccount.expect_runOp(
        'downloadBodyReps',
        { local: false, server: true, save: 'server' });
    }

    eCheck.expect('got body');
    eCheck.expect('bodyReps.length',  (hasFakePart ? 2 : 1));
    eCheck.expect('bodyReps[0].type',  'html');
    eCheck.expect('bodyReps[0].content',  bstrSanitizedFancyHtml);
    eCheck.expect('embeddedImageCount',  2);
    eCheck.expect('embeddedImagesDownloaded',
                  testAccount.type === 'pop3' ? true : false);
    eCheck.expect('checkForExternalImages',  true);
    fancyHeader = folderView.slice.items[idxFancy];

    testAccount.getMessageBodyOnMainThread(fancyHeader, function (body) {
        fancyBody = body;
        eCheck.log('got body');
        eCheck.log('bodyReps.length', fancyBody.bodyReps.length);
        eCheck.log('bodyReps[0].type', fancyBody.bodyReps[0].type);
        eCheck.log('bodyReps[0].content', fancyBody.bodyReps[0].content);
        eCheck.log('embeddedImageCount', fancyBody.embeddedImageCount);
        eCheck.log('embeddedImagesDownloaded',
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
        eCheck.log('checkForExternalImages', results);
      });
  });

  if (testAccount.type !== 'pop3') {
    // (We could verify the HTML rep prior to any transforms, but we already
    // verified the string rep of the HTML.)
    T.action(eCheck, 'download embedded images', function() {
      eCheck.expect('downloaded');
      eCheck.expect('non-null relpart 0',  true);
      eCheck.expect('non-null relpart 1',  true);

      testAccount.expect_runOp(
        'download',
        { local: true, server: true, save: 'server', flushBodyServerSaves: 1 });

      fancyBody.downloadEmbeddedImages(function() {
        eCheck.log('downloaded');
        eCheck.log('non-null relpart 0',
                          !!fancyBody._relatedParts[0].file);
        eCheck.log('non-null relpart 1',
                          !!fancyBody._relatedParts[1].file);
        fancyBody.die();
        fancyBody = null;
      });
    });
  }
  T.check(eCheck, 'show embedded and external images', function() {
    // XXX We used to generate fake URLs ourselves; we would ideally use an XHR
    // to just fetch from the URL to load its content to make sure it's doing
    // the right thing.
    eCheck.expect('image 0 has src',  true);
    eCheck.expect('image 1 has src',  true);
    // the transform should not affect the external image
    eCheck.expect('image 2 has src',  null);

    eCheck.expect('image 0 has src',  true);
    eCheck.expect('image 1 has src',  true);
    eCheck.expect('image 2 has src',  'http://example.com/foo.png');

    testAccount.getMessageBodyOnMainThread(
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
        eCheck.log('image 0 has src', !!results.afterEmbedded[0]);
        eCheck.log('image 1 has src', !!results.afterEmbedded[1]);
        eCheck.log('image 2 has src', results.afterEmbedded[2]);

        eCheck.log('image 0 has src', !!results.afterExternal[0]);
        eCheck.log('image 1 has src', !!results.afterExternal[1]);
        eCheck.log('image 2 has src', results.afterExternal[2]);
      });
  });
  T.check(eCheck, 're-get body, verify embedded images are still there',
          function() {
    eCheck.expect('got body');
    eCheck.expect('bodyReps.length',  (hasFakePart ? 2 : 1));
    eCheck.expect('bodyReps[0].type',  'html');
    eCheck.expect('bodyReps[0].content',  bstrSanitizedFancyHtml);
    eCheck.expect('embeddedImageCount',  2);
    eCheck.expect('embeddedImagesDownloaded',  true);
    eCheck.expect('checkForExternalImages',  true);
    eCheck.expect('image 0 has src',  true);
    eCheck.expect('image 1 has src',  true);
    // the transform should not affect the external image
    eCheck.expect('image 2 has src',  null);

    testAccount.getMessageBodyOnMainThread(
      fancyHeader,
      function(body) {
        fancyBody = body;
        eCheck.log('got body');
        eCheck.log('bodyReps.length', fancyBody.bodyReps.length);
        eCheck.log('bodyReps[0].type', fancyBody.bodyReps[0].type);
        eCheck.log('bodyReps[0].content', fancyBody.bodyReps[0].content);
        eCheck.log('embeddedImageCount', fancyBody.embeddedImageCount);
        eCheck.log('embeddedImagesDownloaded',
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
        eCheck.log('checkForExternalImages', results.externalImages);
        eCheck.log('image 0 has src', !!results.imageSources[0]);
        eCheck.log('image 1 has src', !!results.imageSources[1]);
        eCheck.log('image 2 has src', results.imageSources[2]);
      });
  });

  T.group('unclean account shutdown');
  TU1.do_shutdown();

  T.group('reload universe');
  var TU2 = T.actor('TestUniverse', 'U2', { old: TU1 });
  var TA2 = T.actor('TestAccount', 'A2',
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
    eCheck.expect('got body');
    eCheck.expect('bodyReps.length',  (hasFakePart ? 2 : 1));
    eCheck.expect('bodyReps[0].type',  'html');
    eCheck.expect('bodyReps[0].content',  bstrSanitizedFancyHtml);
    eCheck.expect('embeddedImageCount',  2);
    eCheck.expect('embeddedImagesDownloaded',  true);
    eCheck.expect('checkForExternalImages',  true);
    eCheck.expect('image 0 has src',  true);
    eCheck.expect('image 1 has src',  true);
    // the transform should not affect the external image
    eCheck.expect('image 2 has src',  null);

    fancyHeader = folderView2.slice.items[idxFancy];
    TA2.getMessageBodyOnMainThread(
      fancyHeader,
      function(body) {
        fancyBody = body;
        eCheck.log('got body');
        eCheck.log('bodyReps.length', fancyBody.bodyReps.length);
        eCheck.log('bodyReps[0].type', fancyBody.bodyReps[0].type);
        eCheck.log('bodyReps[0].content', fancyBody.bodyReps[0].content);
        eCheck.log('embeddedImageCount', fancyBody.embeddedImageCount);
        eCheck.log('embeddedImagesDownloaded',
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
        eCheck.log('checkForExternalImages', results.externalImages);
        eCheck.log('image 0 has src', !!results.imageSources[0]);
        eCheck.log('image 1 has src', !!results.imageSources[1]);
        eCheck.log('image 2 has src', results.imageSources[2]);
      });
  });

  T.group('cleanup');
  TA2.do_closeFolderView(folderView2);
});

}); // end define

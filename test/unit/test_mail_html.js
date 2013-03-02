/**
 * Test the more complex parts of HTML message handling, specifically:
 * - multipart/related messages with embedded images
 * - messages with externally referenced images
 * - messages with external links
 **/

load('resources/loggest_test_framework.js');

var TD = $tc.defineTestsFor(
  { id: 'test_mail_html' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('embedded and remote images', function(T) {
  // -- pieces
  var
  // - multipart/related text/html with embedded images, remote images, links
      bstrFancyHtml =
        '<html><head></head><body>image 1: <img src="cid:part1.foo@bar.com">' +
        ' image 2: <img src="cid:part2.foo@bar.com">' +
        ' image 3: <img src="http://example.com/foo.png">' +
        ' <a href="http://example.com/bar.html">link</a></body></html>',
      bstrSanitizedFancyHtml =
        'image 1: <img cid-src="part1.foo@bar.com"' +
        ' class="moz-embedded-image"> ' +
        'image 2: <img cid-src="part2.foo@bar.com"' +
        ' class="moz-embedded-image"> ' +
        'image 3: <img ext-src="http://example.com/foo.png"' +
        ' class="moz-external-image"> ' +
        '<a ext-href="http://example.com/bar.html" class="moz-external-link">' +
        'link</a>',
      bpartFancyHtml =
        new SyntheticPartLeaf(
          bstrFancyHtml, { contentType: 'text/html' }),
      relImage_1 = {
          contentType: 'image/png',
          encoding: 'base64', charset: null, format: null,
          contentId: 'part1.foo@bar.com',
          body: 'cGFydDE=' // "part1" in base64
        },
      partRelImage_1 = new SyntheticPartLeaf(relImage_1.body, relImage_1),
      relImage_2 = {
          contentType: 'image/png',
          encoding: 'base64', charset: null, format: null,
          contentId: 'part2.foo@bar.com',
          body: 'cGFydDI=' // "part2" in base64
        },
      partRelImage_2 = new SyntheticPartLeaf(relImage_2.body, relImage_2),
      bpartRelatedHtml =
        new SyntheticPartMultiRelated(
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

  __blobLogFunc = eCheck.namedValue.bind(eCheck);

  // -- create the folder, append the messages
  var testFolder = testAccount.do_createTestFolder(
    'test_mail_html', function makeMessages() {
    var messageAppends = [],
        msgGen = new MessageGenerator(TU1._useDate);

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
  var idxFancy = 0, fancyHeader = null, fancyBody = null,
      displayDoc = null, displayElem = null;
  T.check(eCheck, 'get fancy body', function() {
    eCheck.expect_event('got body');
    eCheck.expect_namedValue('bodyReps.length', 2);
    eCheck.expect_namedValue('bodyReps[0]', 'html');
    eCheck.expect_namedValue('bodyReps[1]', bstrSanitizedFancyHtml);
    eCheck.expect_namedValue('embeddedImageCount', 2);
    eCheck.expect_namedValue('embeddedImagesDownloaded', false);
    eCheck.expect_namedValue('checkForExternalImages', true);
    fancyHeader = folderView.slice.items[idxFancy];
    fancyHeader.getBody(function(body) {
      fancyBody = body;
      eCheck.event('got body');
      eCheck.namedValue('bodyReps.length', fancyBody.bodyReps.length);
      eCheck.namedValue('bodyReps[0]', fancyBody.bodyReps[0]);
      eCheck.namedValue('bodyReps[1]', fancyBody.bodyReps[1]);
      eCheck.namedValue('embeddedImageCount', fancyBody.embeddedImageCount);
      eCheck.namedValue('embeddedImagesDownloaded',
                        fancyBody.embeddedImagesDownloaded);

      displayDoc = document.implementation.createHTMLDocument('');
      displayElem = displayDoc.body;
      displayElem.innerHTML = fancyBody.bodyReps[1];

      eCheck.namedValue('checkForExternalImages',
                        fancyBody.checkForExternalImages(displayElem));
    });
  });
  // (We could verify the HTML rep prior to any transforms, but we already
  // verified the string rep of the HTML.)
  T.action(eCheck, 'download embedded images', function() {
    eCheck.expect_namedValue('createBlob', 'part1');
    eCheck.expect_namedValue('createBlob', 'part2');
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
    });
  });
  T.check(eCheck, 'show embedded images', function() {
    eCheck.expect_namedValue('createObjectURL', 'url:part1');
    eCheck.expect_namedValue('createObjectURL', 'url:part2');
    eCheck.expect_namedValue('image 0 has src', 'url:part1');
    eCheck.expect_namedValue('image 1 has src', 'url:part2');
    // the transform should not affect the external image
    eCheck.expect_namedValue('image 2 has src', null);

    fancyBody.showEmbeddedImages(displayElem);
    var imgs = displayElem.querySelectorAll('img');
    eCheck.namedValue('image 0 has src', imgs[0].getAttribute('src'));
    eCheck.namedValue('image 1 has src', imgs[1].getAttribute('src'));
    eCheck.namedValue('image 2 has src', imgs[2].getAttribute('src'));
  });
  T.check(eCheck, 'show external images', function() {
    eCheck.expect_namedValue('image 0 has src', 'url:part1');
    eCheck.expect_namedValue('image 1 has src', 'url:part2');
    eCheck.expect_namedValue('image 2 has src', 'http://example.com/foo.png');

    fancyBody.showExternalImages(displayElem);
    var imgs = displayElem.querySelectorAll('img');
    eCheck.namedValue('image 0 has src', imgs[0].getAttribute('src'));
    eCheck.namedValue('image 1 has src', imgs[1].getAttribute('src'));
    eCheck.namedValue('image 2 has src', imgs[2].getAttribute('src'));
  });
  T.action(eCheck, 'kill body, verify URLs retracted', function() {
    eCheck.expect_namedValue('revokeObjectURL', 'url:part1');
    eCheck.expect_namedValue('revokeObjectURL', 'url:part2');
    fancyBody.die();
    fancyBody = null;
  });
  T.check(eCheck, 're-get body, verify embedded images are still there',
          function() {
    eCheck.expect_event('got body');
    eCheck.expect_namedValue('bodyReps.length', 2);
    eCheck.expect_namedValue('bodyReps[0]', 'html');
    eCheck.expect_namedValue('bodyReps[1]', bstrSanitizedFancyHtml);
    eCheck.expect_namedValue('embeddedImageCount', 2);
    eCheck.expect_namedValue('embeddedImagesDownloaded', true);
    eCheck.expect_namedValue('checkForExternalImages', true);
    eCheck.expect_namedValue('createObjectURL', 'url:part1');
    eCheck.expect_namedValue('createObjectURL', 'url:part2');
    eCheck.expect_namedValue('image 0 has src', 'url:part1');
    eCheck.expect_namedValue('image 1 has src', 'url:part2');
    // the transform should not affect the external image
    eCheck.expect_namedValue('image 2 has src', null);

    fancyHeader.getBody(function(body) {
      fancyBody = body;
      eCheck.event('got body');
      eCheck.namedValue('bodyReps.length', fancyBody.bodyReps.length);
      eCheck.namedValue('bodyReps[0]', fancyBody.bodyReps[0]);
      eCheck.namedValue('bodyReps[1]', fancyBody.bodyReps[1]);
      eCheck.namedValue('embeddedImageCount', fancyBody.embeddedImageCount);
      eCheck.namedValue('embeddedImagesDownloaded',
                        fancyBody.embeddedImagesDownloaded);

      displayDoc = document.implementation.createHTMLDocument('');
      displayElem = displayDoc.body;
      displayElem.innerHTML = fancyBody.bodyReps[1];

      eCheck.namedValue('checkForExternalImages',
                        fancyBody.checkForExternalImages(displayElem));

      fancyBody.showEmbeddedImages(displayElem);
      var imgs = displayElem.querySelectorAll('img');
      eCheck.namedValue('image 0 has src', imgs[0].getAttribute('src'));
      eCheck.namedValue('image 1 has src', imgs[1].getAttribute('src'));
      eCheck.namedValue('image 2 has src', imgs[2].getAttribute('src'));
    });
  });

  T.group('unclean account shutdown');
  TU1.do_shutdown();

  T.group('reload universe');
  var TU2 = T.actor('testUniverse', 'U2');
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
    eCheck.expect_namedValue('bodyReps.length', 2);
    eCheck.expect_namedValue('bodyReps[0]', 'html');
    eCheck.expect_namedValue('bodyReps[1]', bstrSanitizedFancyHtml);
    eCheck.expect_namedValue('embeddedImageCount', 2);
    eCheck.expect_namedValue('embeddedImagesDownloaded', true);
    eCheck.expect_namedValue('checkForExternalImages', true);
    eCheck.expect_namedValue('createObjectURL', 'url:part1');
    eCheck.expect_namedValue('createObjectURL', 'url:part2');
    eCheck.expect_namedValue('image 0 has src', 'url:part1');
    eCheck.expect_namedValue('image 1 has src', 'url:part2');
    // the transform should not affect the external image
    eCheck.expect_namedValue('image 2 has src', null);

    fancyHeader = folderView2.slice.items[idxFancy];
    fancyHeader.getBody(function(body) {
      fancyBody = body;
      eCheck.event('got body');
      eCheck.namedValue('bodyReps.length', fancyBody.bodyReps.length);
      eCheck.namedValue('bodyReps[0]', fancyBody.bodyReps[0]);
      eCheck.namedValue('bodyReps[1]', fancyBody.bodyReps[1]);
      eCheck.namedValue('embeddedImageCount', fancyBody.embeddedImageCount);
      eCheck.namedValue('embeddedImagesDownloaded',
                        fancyBody.embeddedImagesDownloaded);

      displayDoc = document.implementation.createHTMLDocument('');
      displayElem = displayDoc.body;
      displayElem.innerHTML = fancyBody.bodyReps[1];

      eCheck.namedValue('checkForExternalImages',
                        fancyBody.checkForExternalImages(displayElem));

      fancyBody.showEmbeddedImages(displayElem);
      var imgs = displayElem.querySelectorAll('img');
      eCheck.namedValue('image 0 has src', imgs[0].getAttribute('src'));
      eCheck.namedValue('image 1 has src', imgs[1].getAttribute('src'));
      eCheck.namedValue('image 2 has src', imgs[2].getAttribute('src'));
    });
  });

  T.group('cleanup');
  T.action(function() {
    fancyBody.die();
  });
  TA2.do_closeFolderView(folderView);
});

function run_test() {
  runMyTests(10);
}

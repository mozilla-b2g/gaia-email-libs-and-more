/**
 * Test the more complex parts of HTML message handling, specifically:
 * - multipart/related messages with embedded images
 * - messages with externally referenced images
 * - messages with external links
 **/

load('resources/loggest_test_framework.js');
// currently the verbatim thunderbird message generator dude
load('resources/messageGenerator.js');

var TD = $tc.defineTestsFor(
  { id: 'test_mail_html' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('MIME hierarchies', function(T) {
  // -- pieces
  var
  // - multipart/related text/html with embedded images, remote images, links
      bstrFancyHtml =
        '<html><head></head><body>image 1: <img src="cid:part1.foo@bar.com">' +
        ' image 2: <img src="cid:part2.foo@bar.com">' +
        ' image 3: <img src="http://example.com/foo.png">' +
        ' <a href="http://example.com/bar.html">link</a></body></html>',
      bstrSanitizedFancyHtml =
        'image 1: <img class="moz-embedded-image"' +
        ' cid-src="cid:part1.foo@bar.com"> ' +
        'image 2: <img class="moz-embedded-image"' +
        ' cid-src="cid:part2.foo@bar.com"> ' +
        'image 3: <img class="moz-external-image"' +
        ' ext-src="http://example.com/foo.png">' +
        '<a class="moz-external-link" ext-href="http://example.com/bar.html">' +
        'link</a>',
      bpartFancyHtml =
        new SyntheticPartLeaf(
          bstrFancyHtml, { contentType: 'text/html' }),
      relImage_1 = {
          contentType: 'image/png',
          encoding: 'base64', charset: null, format: null,
          contentId: 'part1.foo@bar.com',
          body: 'YWJj\n'
        },
      partRelImage_1 = new SyntheticPartLeaf(relImage_1.body, relImage_1),
      relImage_2 = {
          contentType: 'image/png',
          encoding: 'base64', charset: null, format: null,
          contentId: 'part2.foo@bar.com',
          body: 'YWJj\n'
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
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eCheck = T.lazyLogger('messageCheck');

  // -- create the folder, append the messages
  var fullSyncFolder = testAccount.do_createTestFolder(
    'test_mail_html', function makeMessages() {
    var messageAppends = [], msgGen = new MessageGenerator();

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
    'syncs', fullSyncFolder,
    { count: testMessages.length, full: testMessages.length, flags: 0,
      deleted: 0 },
    { top: true, bottom: true, grow: false });

  // -- check each message in its own step
  // - fancy html
  var idxFancy = 0, fancyHeader = null, fancyBody = null;
  T.check(eCheck, 'get fancy body', function() {
    eCheck.expect_event('got body');
    eCheck.expect_namedValue('bodyReps.length', 2);
    eCheck.expect_namedValue('bodyReps[0]', 'html');
    eCheck.expect_namedValue('bodyReps[1]', bstrSanitizedFancyHtml);
    eCheck.expect_namedValue('hasEmbeddedImages', true);
    eCheck.expect_namedValue('hasExternalImages', true);
    fancyHeader = folderView.slice.items[idxFancy];
    fancyHeader.getBody(function(body) {
      fancyBody = body;
      eCheck.event('got body');
      eCheck.namedValue('bodyReps.length', fancyBody.bodyReps.length);
      eCheck.namedValue('bodyReps[0]', fancyBody.bodyReps[0]);
      eCheck.namedValue('bodyReps[1]', fancyBody.bodyReps[1]);
      eCheck.namedValue('hasEmbeddedImages', fancyBody.hasEmbeddedImages);
      eCheck.namedValue('hasExternalImages', fancyBody.hasExternalImages);
    });
  });
  // (We could verify the HTML rep prior to any transforms, but we already
  // verified the string rep of the HTML.)
  T.action(eCheck, 'download embedded images', function() {
  });
  T.check(eCheck, 'show embedded images', function() {
  });
  T.check(eCheck, 'show external images', function() {
  });
  T.action(eCheck, 'kill body, verify URLs retracted', function() {
  });
  T.check(eCheck, 're-get body, re-show embedded images', function() {
  });

  T.group('cleanup');
});

function run_test() {
  runMyTests(5);
}



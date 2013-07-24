/**
 * Test the downloadBodies job for snippet fetching in parallel.  The connection
 * loss variant for downloadBodies is in test_imap_errors.js.
 **/

define(['rdcommon/testcontext', './resources/th_main',
        './resources/messageGenerator', './resources/fault_injecting_socket',
        'exports'],
       function($tc, $th_imap, $msggen, $fawlty, exports) {

var FawltySocketFactory = $fawlty.FawltySocketFactory;

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_imap_parallelfetch' },
  null,
  [$th_imap.TESTHELPER],
  ['app']
);

/**
 * This case is to verify the ordering and content of the initial sync messages.
 * This does _not_ cover database persistence (which is handled in other test
 * cases).
 */
TD.commonCase('fetch N body snippets at once', function(T, RT) {
  var testUniverse = T.actor('testUniverse', 'U', { realDate: true }),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse,
                              realAccountNeeded: true });

  var eLazy = T.lazyLogger('misc');
  var folderName = 'test_imap_parallel_fetch';
  var messageCount = 22;

  var SyntheticPartLeaf = $msggen.SyntheticPartLeaf,
      SyntheticPartMultiAlternative = $msggen.SyntheticPartMultiAlternative,
      SyntheticPartMultiMixed = $msggen.SyntheticPartMultiMixed,
      SyntheticPartMultiRelated = $msggen.SyntheticPartMultiRelated,
      SyntheticPartMultiSignedSMIME = $msggen.SyntheticPartMultiSignedSMIME;


  var partText = new SyntheticPartLeaf("I am text! Woo!");
  var partHtml = new SyntheticPartLeaf(
    "<html><head></head><body>I am HTML! Woo! </body></html>",
    {
      contentType: "text/html"
    }
  );
  var sanitizedHtmlStr = 'I am HTML! Woo!';
  var partAlternative = new SyntheticPartMultiAlternative([partText, partHtml]);
  var mailingListFooterContent = 'I am an annoying footer!';
  var partMailingListFooter = new SyntheticPartLeaf(mailingListFooterContent);
  var relImage = {contentType: 'image/png',
                  encoding: 'base64', charset: null, format: null,
                  contentId: 'part1.foo@bar.com',
                  body: 'YWJj\n'};
  var partRelImage = new SyntheticPartLeaf(relImage.body, relImage);

  var msgPatterns = [
    // - simple text/plain (no hierarchy)
    {
      name: 'text/plain',
      bodyPart: partText,
      bodyStr: partText.body,
      expectedContents: [partText.body]
    },
    // - simple alternative (1-deep hierarchy)
    {
      name: 'text/alternative',
      bodyPart: partAlternative,
      bodyStr: sanitizedHtmlStr,
      expectedContents: [sanitizedHtmlStr]
    },
    // - alternative with related inside (2-deep hierarchy)
    {
      name: 'multipart/related inside multipart/alternative',
      bodyPart:
        new SyntheticPartMultiAlternative(
          [partText, new SyntheticPartMultiRelated([partHtml, partRelImage])]),
      bodyStr: sanitizedHtmlStr,
      expectedContents: [sanitizedHtmlStr]
    },
    // - S/MIME derived complex hierarchy (complex hierarchy!)
    {
      name: 'S/MIME alternative wrapped in mailing list',
      bodyPart: new SyntheticPartMultiMixed(
        [new SyntheticPartMultiSignedSMIME(partAlternative),
         partMailingListFooter]),
      bodyStr: sanitizedHtmlStr,
      expectedContents: [sanitizedHtmlStr, mailingListFooterContent]
    },
  ];

  var msgIdToPattern = {};

  var testFolder = testAccount.do_createTestFolder(
    folderName, function makeMessages() {
    var messageAppends = [],
        msgGen = new $msggen.MessageGenerator(testUniverse._useDate);

    for (var i = 0; i < messageCount; i++) {
      var msgDef = msgPatterns[i % msgPatterns.length];
      msgDef.age = { days: 1, minutes: i * 20 };
      var synMsg = msgGen.makeMessage(msgDef);
      messageAppends.push(synMsg);
      msgIdToPattern[synMsg.messageId] = msgDef;
    }

    return messageAppends;
  }, { messageCount: messageCount}); // give count for timeout purposes

  var folderView = testAccount.do_openFolderView(
    folderName, testFolder,
    null,
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: 'ignore' });


  var imapSocket;

  T.group('recieving data');

  T.action('recieve fetches in random order', eLazy, function() {
    // we don't care about order only correctness
    eLazy.expectUseSetMatching();

    folderView.slice.items.forEach(function(header) {
      var serverMsg = testFolder.findServerMessage(header.guid);
      var msgDef = msgIdToPattern[header.guid];
      // HACK: just use the string from the def
      var snippetBodyRepContent = msgDef.bodyStr;
      if (!snippetBodyRepContent)
        throw new Error('no server content for guid: ' + header.guid);
      var snippet = snippetBodyRepContent.slice(0, 20);

      eLazy.expect_namedValue('snippet', {
        id: header.id,
        // snippets are usually trimmed
        approxSnippet: snippet.trim()
      });

      eLazy.expect_namedValue('bodyReps', {
        id: header.id,
        contents: msgDef.expectedContents,
        isDownloaded: true
      });

      header.onchange = function() {
        header.getBody({ withBodyReps: true }, function(body) {
          if (!body) {
            // ???!
            eLazy.namedValue('missing body for header', header.id);
            return;
          }

          var contents = body.bodyReps.map(function(item) {
            return ((Array.isArray(item.content)) ?
              item.content[1] : item.content).trim();
          });

          eLazy.namedValue('bodyReps', {
            id: header.id,
            contents: contents,
            isDownloaded: body.bodyReps[0].isDownloaded
          });

          body.die();
        });

        eLazy.namedValue('snippet', {
          id: header.id,
          approxSnippet: header.snippet.slice(0, 20).trim()
        });
      };
    });

    folderView.slice.maybeRequestBodies(0, messageCount + 1);
  });

});

}); // end define

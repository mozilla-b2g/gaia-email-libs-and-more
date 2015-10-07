/**
 * Test the downloadBodies job for snippet fetching in parallel.  The connection
 * loss variant for downloadBodies is in test_imap_errors.js.
 **/

define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var $msggen = require('./resources/messageGenerator');
var $fawlty = require('./resources/fault_injecting_socket')
var FawltySocketFactory = $fawlty.FawltySocketFactory;

/**
 * This case is to verify the ordering and content of the initial sync messages.
 * This does _not_ cover database persistence (which is handled in other test
 * cases).
 */
return new LegacyGelamTest('fetch N body snippets at once', function(T, RT) {
  var testUniverse = T.actor('TestUniverse', 'U', { realDate: true }),
      testAccount = T.actor('TestAccount', 'A',
                            { universe: testUniverse,
                              realAccountNeeded: true });

  // To improve logging visibility, use a separate lazy logger for each.
  var eSnippet = T.lazyLogger('snippet'),
      eBody = T.lazyLogger('body');

  var folderName = 'test_imap_parallel_fetch';
  var messageCount = 22;

  var SyntheticPartLeaf = $msggen.SyntheticPartLeaf,
      SyntheticPartMultiAlternative = $msggen.SyntheticPartMultiAlternative,
      SyntheticPartMultiMixed = $msggen.SyntheticPartMultiMixed,
      SyntheticPartMultiRelated = $msggen.SyntheticPartMultiRelated,
      SyntheticPartMultiSignedSMIME = $msggen.SyntheticPartMultiSignedSMIME;


  // Build a sufficiently large text part that the snippeting logic won't
  // download the entire body part.  Since we currently use 4k everywhere,
  // but in some cases will double to go up to 8k if that gets the whole
  // thing, make sure we are over 8k.
  var hugeText, textLines = [];
  for (var iHuge = 0; iHuge < (8192 / 64) + 1; iHuge++) {
    textLines.push('abcdefghijklmnopqrstuvwxyz' + // 26
                   'ABCDEFGHIJKLMNOPQRSTUVWXYZ' + // 26 => 52
                   '0123456789'); // 10 + (\r\n) 2 = 12 => 64
  }
  // Note that we only use \n but messageGenerator will expand it out to be
  // \r\n.  We do this because our backend only uses \n when it reports things
  // to us.
  hugeText = textLines.join('\n');

  var partText = new SyntheticPartLeaf("I am text! Woo!");
  var partHugeText = new SyntheticPartLeaf(hugeText);
  var partHtml = new SyntheticPartLeaf(
    "<html><head></head><body>I am HTML! Woo! </body></html>",
    {
      contentType: "text/html"
    }
  );
  var partHugeHtml = new SyntheticPartLeaf(
    "<html><head></head><body>" + hugeText + "</body></html>",
    {
      contentType: "text/html"
    }
  );
  var sanitizedHtmlStr = 'I am HTML! Woo!';
  var partAlternative = new SyntheticPartMultiAlternative([partText, partHtml]);
  var partHugeAlternative = new SyntheticPartMultiAlternative(
                              [partHugeText, partHugeHtml]);
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
    // - mailing-list style mixed alternative (html or text) with list footer
    // in this one, we expect our snippet fetch to fetch both body parts
    {
      name: 'mailing list with 2 small body parts',
      bodyPart: new SyntheticPartMultiMixed(
        [partAlternative,
         partMailingListFooter]),
      bodyStr: sanitizedHtmlStr,
      expectedContents: [sanitizedHtmlStr, mailingListFooterContent]
    },
    // in this one, the first body part is big enough that we won't fetch the
    // footer.
    {
      name: 'mailing list with 1 big and 1 small body part',
      bodyPart: new SyntheticPartMultiMixed(
        [partHugeAlternative,
         partMailingListFooter]),
      bodyStr: hugeText,
      expectedContents: [hugeText, mailingListFooterContent]
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

  T.group('receiving data');

  T.action('recieve fetches in random order', eSnippet, eBody, function() {
    // The order is defined to be random, and by golly, it sure comes out
    // random!
    eSnippet.useSetMatching();
    eBody.useSetMatching();

    folderView.slice.items.forEach(function(header) {
      var serverMsg = testFolder.findServerMessage(header.guid);
      var msgDef = msgIdToPattern[header.guid];
      // HACK: just use the string from the def
      var snippetBodyRepContent = msgDef.bodyStr;
      if (!snippetBodyRepContent)
        throw new Error('no server content for guid: ' + header.guid);
      var snippet = snippetBodyRepContent.slice(0, 20);

      eSnippet.expect('snippet', {
        id: header.id,
        name: msgDef.name,
        // snippets are usually trimmed
        approxSnippet: snippet.trim()
      });

      eBody.expect('bodyReps', {
        id: header.id,
        contents: msgDef.expectedContents,
        isDownloaded: true
      });

      var gotSnippet = false;
      header.onchange = function() {
        // We now fire onchange even if the snippet hasn't been
        // populated yet, so check first to make sure we have a
        // snippet before providing the namedValue. Since onchange
        // might now be called more than once, we need to guard the
        // getBody() call to ensure we don't provide namedValue more
        // than once per header.
        if (header.snippet != null && !gotSnippet) {
          gotSnippet = true;
          header.getBody({ withBodyReps: true }, function(body) {
            if (!body) {
              eBody.log('missing body for header', header.id);
              return;
            }

            var contents = body.bodyReps.map(function(item) {
              return ((Array.isArray(item.content)) ?
                      item.content[1] : item.content).trim();
            });

            eBody.log('bodyReps', {
              id: header.id,
              contents: contents,
              isDownloaded: body.bodyReps[0].isDownloaded
            });

            body.die();
          });

          eSnippet.log('snippet', {
            id: header.id,
            name: msgDef.name,
            approxSnippet: header.snippet.slice(0, 20).trim()
          });
        }
      };
    });

    folderView.slice.maybeRequestBodies(0, messageCount + 1,
                                        { maximumBytesToFetch: 4096 });
  });

});

}); // end define

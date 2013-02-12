/**
 * Test our processing of MIME messages.  Because we leave most of this up to
 * the IMAP server, this ends up being a test of:
 * - `imapchew.js`
 * - the sync logic in `mailslice.js`'s ability to cram things into mailparser
 * - the (external) mailparser lib
 * - `htmlchew.js`
 * - the (external) bleach.js lib
 **/

load('resources/loggest_test_framework.js');

var TD = $tc.defineTestsFor(
  { id: 'test_imap_mime' }, null, [$th_imap.TESTHELPER], ['app']);

// The example string comes from wikipedia, and it now seems to be a popular
// test phrase.  See http://en.wikipedia.org/wiki/Quoted-printable
var rawTruthBeauty =
      'If you believe that truth=beauty, then surely ' +
      'mathematics is the most beautiful branch of philosophy.',
    qpTruthBeauty =
      'If you believe that truth=3Dbeauty, then surely=20=\r\n' +
      'mathematics is the most beautiful branch of philosophy.',
    b64TruthBeauty = window.btoa(rawTruthBeauty);
b64TruthBeauty = b64TruthBeauty.substring(0, 76) + '\r\n' +
                 b64TruthBeauty.substring(76);

// "Snake, Sammy", but with a much cooler looking S-like character!
var rawSammySnake = '\u00dfnake, \u00dfammy',
    mwqSammySnake = '=?iso-8859-1?Q?=DFnake=2C_=DFammy?=',
    rawMultiBase64 = 'Sssś Lałalalala',
    mwbMultiBase64 = '=?UTF-8?B?U3NzxZsgTGHFgmFsYQ==?= =?UTF-8?B?bGFsYQ==?=',
    rawBase64Gibberish = 'A\u0004\u0011E\u0014',
    mwbBase64Gibberish = '=?UTF-8?B?Q!Q#@Q$RR$RR=====?=';

var rawUnicodeName = 'Figui\u00e8re',
    utf8UnicodeName = new Buffer('Figui\u00c3\u00a8re', 'binary'),
    qpUtf8UnicodeName = 'Figui=C3=A8re';


/**
 * Create messages with very explicit body contents using the fake account's
 * message generator fork.
 */
TD.commonCase('message encodings', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A', { universe: testUniverse }),
      eBodies = T.lazyLogger('bodies');

  var fullSyncFolder = testAccount.do_createTestFolder(
    'test_mime_encodings',
    { count: 2, age: { days: 0 }, age_incr: { days: 1 },
      from: { name: mwqSammySnake, address: 'sammy@snake.nul' },
      to: [{ name: mwqSammySnake, address: 'sammy@snake.nul' },
           { name: mwbMultiBase64, address: 'raw@multi.nul' },
           { name: mwbBase64Gibberish, address: 'gibber@ish.nul'}],
      cc: [{ name: mwqSammySnake, address: 'sammy@snake.nul' }],
      // replace the actual encoding with these values...
      replaceHeaders: [
        { 'Content-Transfer-Encoding': 'quoted-printable' },
        { 'Content-Transfer-Encoding': 'base64' },
      ],
      rawBodies: [
        qpTruthBeauty,
        b64TruthBeauty
      ]
    });
  var folderView = testAccount.do_openFolderView(
    'syncs', fullSyncFolder,
    { count: 2, full: 2, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  T.check('check messages', eBodies, function() {
    eBodies.expect_namedValue('from name', rawSammySnake);
    eBodies.expect_namedValue('to[0] name', rawSammySnake);
    eBodies.expect_namedValue('to[1] name', rawMultiBase64);
    eBodies.expect_namedValue('to[2] name', rawBase64Gibberish);
    eBodies.expect_namedValue('cc[0] name', rawSammySnake);
    eBodies.expect_namedValue('qp', rawTruthBeauty);
    eBodies.expect_namedValue('b64', rawTruthBeauty);

    var qpHeader = folderView.slice.items[0],
        b64Header = folderView.slice.items[1];
    eBodies.namedValue('from name', qpHeader.author.name);
    qpHeader.getBody(function(qpBody) {
    eBodies.namedValue('to[0] name', qpBody.to[0].name);
    eBodies.namedValue('to[1] name', qpBody.to[1].name);
    eBodies.namedValue('to[2] name', qpBody.to[2].name);
    eBodies.namedValue('cc[0] name', qpBody.cc[0].name);
      eBodies.namedValue('qp', qpBody.bodyReps[1][1]);
      qpBody.die();
    });
    b64Header.getBody(function(b64Body) {
      eBodies.namedValue('b64', b64Body.bodyReps[1][1]);
      b64Body.die();
    });
  });

  T.group('cleanup');
});

/**
 * Use Thunderbird/gloda's synthetic message generator support and some of its
 * tests cases.  Because we are not concerned about MIME tree equivalence, we
 * explicitly indicate what parts should be seen as bodies or attachments by
 * us, differing from what gloda's time_mime_emitter.js checks.
 */
TD.commonCase('MIME hierarchies', function(T) {
  // -- pieces
  var
  // - bodies: text/plain
      bpartEmptyText =
        new SyntheticPartLeaf(''),
      bpartStraightASCII =
        new SyntheticPartLeaf('I am text! Woo!'),
      longBodyStr =
        'This is a very long message that wants to be snippeted to a ' +
        'reasonable length that is reasonable and not unreasonable.  It is ' +
        'neither too long nor too short.  Not too octogonal nor hexagonal. ' +
        'It is just right.',
      bpartLongBodyText =
        new SyntheticPartLeaf(longBodyStr),
      bpartUtf8Name =
        new SyntheticPartLeaf(
          utf8UnicodeName,
          { charset: 'utf-8', format: null, encoding: '8bit' }),
      // quoted-printable encoding utf-8
      bpartQpUtf8Name =
        new SyntheticPartLeaf(
          qpUtf8UnicodeName,
          { charset: 'utf-8', format: null, encoding: 'quoted-printable' }),
      // Body text that contains a mime word that should *not* be decoded.
      bpartMimeWord =
        new SyntheticPartLeaf(
          mwqSammySnake,
          { charset: 'utf-8', format: null, encoding: null }),
      bstrQpWin1252 =
        'Ellipsis: "=85", apostrophe "=92", accented i "=ED"',
      rawQpWin1252 =
        'Ellipsis: "\u2026", apostrophe "\u2019", accented i "\u00ed"',
      bpartQpWin1252 =
        new SyntheticPartLeaf(
          bstrQpWin1252,
          { charset: 'windows-1252', format: null,
            encoding: 'quoted-printable' }),
      bpartQpWin1252ShortenedCharset =
        new SyntheticPartLeaf(
          bstrQpWin1252,
          { charset: 'win-1252', format: null,
            encoding: 'quoted-printable' }),
      rawFlowed = 'Foo Bar Baz',
      bstrFlowed = 'Foo \nBar \nBaz',
      bstrQpFlowed = 'Foo =\n\nBar =\n\nBaz',
      bpartFlowed =
        new SyntheticPartLeaf(
          bstrFlowed,
          { charset: 'iso-8859-1', format: 'flowed', encoding: '7-bit' }),
      bpartQpFlowed =
        new SyntheticPartLeaf(
          bstrQpFlowed,
          { charset: 'iso-8859-1', format: 'flowed',
            encoding: 'quoted-printable' }),

  // - bodies: text/enriched (ignored!)
  // This exists just to test the alternatives logic.
      bpartIgnoredEnriched =
        new SyntheticPartLeaf(
          '<bold><italic>I am not a popular format! sad woo :(</italic></bold>',
          { contentType: 'text/enriched' }),

  // - bodies: text/html
      bstrTrivialHtml =
        '<html><head></head><body>I am HTML! Woo!</body></html>',
      bstrSanitizedTrivialHtml =
        'I am HTML! Woo!',
      bpartTrivialHtml =
        new SyntheticPartLeaf(
          bstrTrivialHtml,  { contentType: 'text/html' }),
      bstrLimitedHtml =
        '<div>I <form>am <span>HTML!</span></form></div>',
      bstrSanitizedLimitedHtml =
        '<div>I am <span>HTML!</span></div>',
      bpartLimitedHtml =
        new SyntheticPartLeaf(
          bstrLimitedHtml, { contentType: 'text/html' }),
      bstrLongTextHtml =
        '<p>This is a very long message that wants to be snippeted to a ' +
        'reasonable length that is reasonable and not unreasonable.  It is ' +
        'neither too long nor too short.  Not too octogonal nor hexagonal. ' +
        'It is just right.</p>',
      bpartLongTextHtml =
        new SyntheticPartLeaf(
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
        new SyntheticPartLeaf(
          bstrStyleHtml, { contentType: 'text/html' }),

  // - multipart/alternative where text/plain should be chosen
      alternStraight =
        new SyntheticPartMultiAlternative(
          [bpartStraightASCII, bpartIgnoredEnriched]),
      alternUtf8Name =
        new SyntheticPartMultiAlternative(
          [bpartUtf8Name, bpartIgnoredEnriched]),
      alternQpUtf8Name =
        new SyntheticPartMultiAlternative(
          [bpartQpUtf8Name, bpartIgnoredEnriched]),
      // FUTURE: maybe text/html and text/plain with text/plain last and
      // therefore theoretically preferred?  Worth checking if anyone honors it.

  // - multipart/alternative where text/html should be chosen
      alternHtml =
        new SyntheticPartMultiAlternative(
          [bpartStraightASCII, bpartTrivialHtml]);

  // -- full definitions and expectations
  var testMessages = [
    // - text/plain variants
    // Empty contents with care taken to alter messageGenerator.js to generate
    // a zero-length body.  This previously broke us.
    {
      name: 'text/plain with empty contents',
      bodyPart: bpartEmptyText,
      checkBody: '',
    },
    // Check snippet logic is hooked up correctly; we already run this test in
    // isolation, but I swear I saw bad snippets in my db once...
    {
      name: 'text/plain snippet processing',
      bodyPart: bpartLongBodyText,
      checkBody: longBodyStr,
      checkSnippet:
        'This is a very long message that wants to be snippeted to a ' +
        'reasonable length that is reasonable and',
    },
    {
      name: 'text/plain utf8',
      bodyPart: bpartUtf8Name,
      checkBody: rawUnicodeName,
    },
    {
      name: 'text/plain qp utf8',
      bodyPart: bpartQpUtf8Name,
      checkBody: rawUnicodeName,
    },
    {
      name: 'text/plain qp windows-1252',
      bodyPart: bpartQpWin1252,
      checkBody: rawQpWin1252,
    },
    {
      name: 'text/plain qp win-1252 (incorrectly shortened from windows-1252)',
      bodyPart: bpartQpWin1252ShortenedCharset,
      checkBody: rawQpWin1252,
    },
    {
      name: 'format=flowed, 7-bit encoding',
      bodyPart: bpartFlowed,
      checkBody: rawFlowed,
    },
    {
      name: 'format=flowed, quoted-printable encoding',
      bodyPart: bpartQpFlowed,
      checkBody: rawFlowed,
    },
    // - text/plain checking things not related to bodies...
    {
      name: 'text/plain with sender without display name',
      bodyPart: bpartEmptyText,
      from: [null, 'nodisplayname@example.com'],
      to: [[null, 'nodisplayname2@example.com']],
      checkBody: '',
    },
    // - straight up verification we don't do mime-word decoding on bodies
    {
      name: 'simple text/plain with mimeword in the body',
      bodyPart: bpartMimeWord,
      // the body should not get decoded; it should still be the mime-word
      checkBody: mwqSammySnake,
    },
    // - alternatives that test proper (text/plain) encoding
    {
      name: 'multipart/alternative simple',
      bodyPart: alternStraight,
      checkBody: "I am text! Woo!",
    },
    {
      name: 'multipart/alternative utf8',
      bodyPart: alternUtf8Name,
      checkBody: rawUnicodeName,
    },
    {
      name: 'multipart/alternative qp utf8',
      bodyPart: alternQpUtf8Name,
      checkBody: rawUnicodeName,
    },
    // - text/html
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
    // - alternative chooses text/html
    {
      name: 'multipart/alternative choose text/html',
      bodyPart: alternHtml,
      checkBody: bstrSanitizedTrivialHtml,
    },
  ];

  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eCheck = T.lazyLogger('messageCheck');


  var DISABLE_THRESH_USING_FUTURE = -60 * 60 * 1000;
  testUniverse.do_adjustSyncValues({
    // only fillSize and days are adjusted; we want to synchronize everything
    // in one go.
    fillSize: testMessages.length,
    days: testMessages.length,
    // the rest are defaults here...
    scaleFactor: 1.6,
    bisectThresh: 2000,
    tooMany: 2000,
    refreshNonInbox: DISABLE_THRESH_USING_FUTURE,
    refreshInbox: DISABLE_THRESH_USING_FUTURE,
    oldIsSafeForRefresh: DISABLE_THRESH_USING_FUTURE,
    refreshOld: DISABLE_THRESH_USING_FUTURE,
    useRangeNonInbox: DISABLE_THRESH_USING_FUTURE,
    useRangeInbox: DISABLE_THRESH_USING_FUTURE
  });

  // -- create the folder, append the messages
  var fullSyncFolder = testAccount.do_createTestFolder(
    'test_mime_hier', function makeMessages() {
    var messageAppends = [],
        msgGen = new MessageGenerator(testUniverse._useDate);

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
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  // -- check each message in its own step
  testMessages.forEach(function checkMessage(msgDef, iMsg) {
    T.check(eCheck, msgDef.name, function() {
      eCheck.expect_namedValue('body', msgDef.checkBody);
      if (msgDef.checkSnippet)
        eCheck.expect_namedValue('snippet', msgDef.checkSnippet);
      if ('attachments' in msgDef) {
        for (var i = 0; i < msgDef.attachments.length; i++) {
          eCheck.expect_namedValue('attachment-name',
                                   msgDef.attachments[i].filename);
          eCheck.expect_namedValue('attachment-size',
                                   msgDef.attachments[i].body.length);
        }
      }

      var header = folderView.slice.items[iMsg];
      header.getBody(function(body) {
        var bodyValue;
        if (!body.bodyReps.length)
          bodyValue = '';
        else if (body.bodyReps[0] === 'plain')
          bodyValue = body.bodyReps[1][1] || '';
        else if (body.bodyReps[0] === 'html')
          bodyValue = body.bodyReps[1];
        eCheck.namedValue('body', bodyValue);
        if (msgDef.checkSnippet)
          eCheck.namedValue('snippet', header.snippet);
        if (body.attachments && body.attachments.length) {
          for (var i = 0; i < body.attachments.length; i++) {
            eCheck.namedValue('attachment-name', body.attachments[i].filename);
            eCheck.namedValue('attachment-size',
                              body.attachments[i].sizeEstimateInBytes);
          }
        }
        body.die();
      });
    });
  });

  T.group('cleanup');
});

function run_test() {
  runMyTests(5);
}

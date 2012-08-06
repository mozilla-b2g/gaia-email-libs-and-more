/**
 * Test our processing of MIME messages.  Because we leave most of this up to
 * the IMAP server, this ends up being a test of:
 * - `imapchew.js`
 * - the sync logic in `imapslice.js`'s ability to cram things into mailparser
 * - the (external) mailparser lib
 * - `htmlchew.js`
 * - the (external) bleach.js lib
 **/

load('resources/loggest_test_framework.js');
// currently the verbatim thunderbird message generator dude
load('resources/messageGenerator.js');

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
    mwqSammySnake = '=?iso-8859-1?Q?=DFnake=2C_=DFammy?=';

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
      testAccount = T.actor('testImapAccount', 'A', { universe: testUniverse }),
      eBodies = T.lazyLogger('bodies');

  var fullSyncFolder = testAccount.do_createTestFolder(
    'test_mime_encodings',
    { count: 2, age: { days: 0 }, age_incr: { days: 1 },
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
    { top: true, bottom: true, grow: false });
  T.check('check message', eBodies, function() {
    eBodies.expect_namedValue('qp', rawTruthBeauty);
    eBodies.expect_namedValue('b64', rawTruthBeauty);

    var qpHeader = folderView.slice.items[0],
        b64Header = folderView.slice.items[1];
    qpHeader.getBody(function(qpBody) {
      eBodies.namedValue('qp', qpBody.bodyReps[1][1]);
    });
    b64Header.getBody(function(b64Body) {
      eBodies.namedValue('b64', b64Body.bodyReps[1][1]);
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
  // - bodies: text/plain
  var bpartEmptyText =
        new SyntheticPartLeaf(''),
      bpartStraightASCII =
        new SyntheticPartLeaf('I am text! Woo!'),
      bpartUtf8Name =
        new SyntheticPartLeaf(
          utf8UnicodeName,
          { charset: 'utf-8', format: null, encoding: '8bit' }),
      bpartQpUtf8Name =
        new SyntheticPartLeaf(
          qpUtf8UnicodeName,
          { charset: 'utf-8', format: null, encoding: 'quoted-printable' }),
      // Body text that contains a mime word that should *not* be decoded.
      bpartMimeWord =
        new SyntheticPartLeaf(
          mwqSammySnake,
          { charset: 'utf-8', format: null, encoding: null }),
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
        '<div>I <font>am <span>HTML!</span></font></div>',
      bstrSanitizedLimitedHtml =
        '<div>I am <span>HTML!</span></div>',
      bpartLimitedHtml =
        new SyntheticPartLeaf(
          bstrLimitedHtml, { contentType: 'text/html' }),

  // - multipart/related text/html with embedded images
      bstrHtmlWithCids =
        '<html><head></head><body>image 1: <img src="cid:part1.foo@bar.com">' +
        ' image 2: <img src="cid:part2.foo@bar.com"></body></html>',
      bpartHtmlWithCids =
        new SyntheticPartLeaf(
          bstrHtmlWithCids, { contentType: 'text/html' }),
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
          [bpartHtmlWithCids, partRelImage_1, partRelImage_2]),

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
    // - alternative chooses text/html
    {
      name: 'multipart/alternative choose text/html',
      bodyPart: alternHtml,
      checkBody: bstrSanitizedTrivialHtml,
    },
  ];

  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testImapAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eCheck = T.lazyLogger('messageCheck');

  // -- create the folder, append the messages
  var fullSyncFolder = testAccount.do_createTestFolder(
    'test_mime_hier', function makeMessages() {
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
  testMessages.forEach(function checkMessage(msgDef, iMsg) {
    T.check(eCheck, msgDef.name, function() {
      eCheck.expect_namedValue('body', msgDef.checkBody);
      if ('attachments' in msgDef) {
        for (var i = 0; i < msgDef.attachments.length; i++) {
          eCheck.expect_namedValue('attachment', msgDef.attachments._filename);
        }
      }

      folderView.slice.items[iMsg].getBody(function(body) {
        var bodyValue;
        if (!body.bodyReps.length)
          bodyValue = '';
        else if (body.bodyReps[0] === 'plain')
          bodyValue = body.bodyReps[1][1] || '';
        else if (body.bodyReps[0] === 'html')
          bodyValue = body.bodyReps[1];
        eCheck.namedValue('body', bodyValue);
        if (body.attachments && body.attachments.length) {
          for (var i = 0; i < body.attachments.length; i++) {
            eCheck.expect_namedValue('attachment',
                                     body.attachments[i].filename);
          }
        }
      });
    });
  });

  T.group('cleanup');
});

function run_test() {
  runMyTests(5);
}

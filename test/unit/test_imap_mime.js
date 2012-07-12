/**
 * Test our processing of MIME messages.  Because we leave most of this up to
 * the IMAP server, this ends up being a test of `imapchew.js`, the sync logic
 * in `imapslice.js`'s ability to cram things into mailparser, and the
 * mailparser lib itself.
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
    { count: 2, full: 2, flags: 0, deleted: 0 });
  T.check('check message', eBodies, function() {
    eBodies.expect_namedValue('qp', rawTruthBeauty);
    eBodies.expect_namedValue('b64', rawTruthBeauty);

    var qpHeader = folderView.slice.items[0],
        b64Header = folderView.slice.items[1];
    qpHeader.getBody(function(qpBody) {
      eBodies.namedValue('qp', qpBody.bodyRep[1]);
    });
    b64Header.getBody(function(b64Body) {
      eBodies.namedValue('b64', b64Body.bodyRep[1]);
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
  var bpartStraightASCII =
        new SyntheticPartLeaf("I am text! Woo!"),
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
  // - bodies: text/html
      bpartIgnoredHtml =
        new SyntheticPartLeaf(
          "<html><head></head><body>I am HTML! Woo! </body></html>",
          { contentType: 'text/html' }),

  // - multipart/alternative
  // NB: currently we ignore HTML body parts!
      alternStraight =
        new SyntheticPartMultiAlternative(
          [bpartStraightASCII, bpartIgnoredHtml]),
      alternUtf8Name =
        new SyntheticPartMultiAlternative(
          [bpartUtf8Name, bpartIgnoredHtml]),
      alternQpUtf8Name =
        new SyntheticPartMultiAlternative(
          [bpartQpUtf8Name, bpartIgnoredHtml]);

  // -- full definitions and expectations
  var testMessages = [
    // - straight up verification we don't do mime-word decoding on bodies
    {
      name: 'simple text/plain with mimeword in the body',
      bodyPart: bpartMimeWord,
      // the body should not get decoded; it should still be the mime-word
      checkBody: mwqSammySnake,
    },
    // - alternatives that test proper encoding
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
      deleted: 0 });
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
        eCheck.namedValue('body', body.bodyRep[1]);
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

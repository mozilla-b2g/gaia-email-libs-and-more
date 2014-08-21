/**
 * Test our processing of MIME messages.  Because we leave most of this up to
 * the IMAP server, this ends up being a test of:
 * - `imapchew.js`
 * - the sync logic in `mailslice.js`'s ability to cram things into mimeparser
 * - the (external) mimeparser lib
 * - `htmlchew.js`
 * - the (external) bleach.js lib
 **/

define(['rdcommon/testcontext', './resources/th_main',
        './resources/messageGenerator', 'exports'],
       function($tc, $th_imap, $msggen, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_mime' }, null, [$th_imap.TESTHELPER], ['app']);

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
    utf8UnicodeName = 'Figuière',
    utf7UnicodeName = 'Figui+AOg-re',
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
    'test_mime_encodings', function makeMessages() {
      var msgGen = new $msggen.MessageGenerator(testAccount._useDate);
      var baseMsgDef = {
        from: { name: mwqSammySnake, address: 'sammy@snake.nul' },
        to: [{ name: mwqSammySnake, address: 'sammy@snake.nul' },
             { name: mwbMultiBase64, address: 'raw@multi.nul' },
             { name: mwbBase64Gibberish, address: 'gibber@ish.nul'}],
        cc: [{ name: mwqSammySnake, address: 'sammy@snake.nul' }]
      };
      var msgBodies = [
        {body: qpTruthBeauty, encoding: 'quoted-printable'},
        {body: b64TruthBeauty, encoding: 'base64'}
      ];

      var messageAppends = [];
      for (var i = 0; i < msgBodies.length; i++) {
        baseMsgDef.age = {days: i};
        baseMsgDef.body = msgBodies[i];
        messageAppends.push(msgGen.makeMessage(baseMsgDef));
      }
      return messageAppends;
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

    eBodies.namedValue('to[0] name', qpHeader.to[0].name);
    eBodies.namedValue('to[1] name', qpHeader.to[1].name);
    eBodies.namedValue('to[2] name', qpHeader.to[2].name);
    eBodies.namedValue('cc[0] name', qpHeader.cc[0].name);

    qpHeader.getBody({ withBodyReps: true }, function(qpBody) {
      eBodies.namedValue('qp', qpBody.bodyReps[0].content[1]);
      qpBody.die();
    });

    b64Header.getBody({ withBodyReps: true }, function(b64Body) {
      eBodies.namedValue('b64', b64Body.bodyReps[0].content[1]);
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
  var SyntheticPartLeaf = $msggen.SyntheticPartLeaf,
      SyntheticPartMultiAlternative = $msggen.SyntheticPartMultiAlternative;

  // -- pieces
  var
  // - bodies: text/plain
      bpartEmptyText =
        new SyntheticPartLeaf(''),
      bpartStraightASCII =
        new SyntheticPartLeaf('I am text! Woo!'),
      bpartPeriod =
        new SyntheticPartLeaf('start\n.with\n.\nperiod\n.two.'),
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
      bpartUtf7Name =
        new SyntheticPartLeaf(
          utf7UnicodeName,
          { charset: 'utf-7' }),
      bpartUtf7HtmlName =
        new SyntheticPartLeaf(
          utf7UnicodeName,
          { contentType: 'text/html', charset: 'utf-7' }),
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
      period = 'start\n.withperiod\n.two',

  // - bodies: text/enriched (ignored!)
  // This exists just to test the alternatives logic.
      bpartIgnoredEnriched =
        new SyntheticPartLeaf(
          '<bold><italic>I am not a popular format! sad woo :(</italic></bold>',
          { contentType: 'text/enriched' }),

  // - bodies: text/html
      bstrEmptyHtml = '',
      bpartEmptyHtml =
        new SyntheticPartLeaf(
          bstrEmptyHtml, { contentType: 'text/html' }),
      bstrSanitizedEmptyHtml = '',
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
      bstrForwardedHtml = [
        '<html>',
        '  <head>',
        '',
        '    <meta http-equiv="content-type" content="text/html; charset=UTF-8">',
        '  </head>',
        '  <body text="#000000" bgcolor="#FFFFFF">',
        '    <br>',
        '    <div class="moz-forward-container"><br>',
        '      <br>',
        '      -------- Original Message --------',
        '      <table class="moz-email-headers-table" border="0" cellpadding="0"',
        '        cellspacing="0">',
        '        <tbody>',
        '          <tr>',
        '            <th nowrap="nowrap" valign="BASELINE" align="RIGHT">Date: </th>',
        '            <td>Wed, 30 Jan 2013 18:01:02 +0530</td>',
        '          </tr>',
        '          <tr>',
        '            <th nowrap="nowrap" valign="BASELINE" align="RIGHT">From: </th>',
        '            <td>Foo Bar <a class="moz-txt-link-rfc2396E" href="mailto:foo@example.com">&lt;foo@example.com&gt;</a></td>',
        '          </tr>',
        '        </tbody>',
        '      </table>',
        '      <br>',
        '      <br>',
        '      <br>',
        '    </div>',
        '    <br>',
        '  </body>',
        '</html>'].join('\n'),
  // This one has one less space on each line due to space-stuffing (format=flowed)
      bstrSanitizedForwardedHtml = [
        '',
        ' ',
        '',
        '   ',
        ' ',
        ' ',
        '   <br/>',
        '   <div class="moz-forward-container"><br/>',
        '     <br/>',
        '     -------- Original Message --------',
        '     <table class="moz-email-headers-table" border="0" cellpadding="0" cellspacing="0">',
        '       <tbody>',
        '         <tr>',
        '           <th nowrap="nowrap" valign="BASELINE" align="RIGHT">Date: </th>',
        '           <td>Wed, 30 Jan 2013 18:01:02 +0530</td>',
        '         </tr>',
        '         <tr>',
        '           <th nowrap="nowrap" valign="BASELINE" align="RIGHT">From: </th>',
        '           <td>Foo Bar <a class="moz-txt-link-rfc2396E moz-external-link" ext-href="mailto:foo@example.com">&lt;foo@example.com&gt;</a></td>',
        '         </tr>',
        '       </tbody>',
        '     </table>',
        '     <br/>',
        '     <br/>',
        '     <br/>',
        '   </div>',
        '   <br/>',
        ' ',
        ''].join('\n'),
      bpartForwardedHtml =
        new SyntheticPartLeaf(
          bstrForwardedHtml, { contentType: 'text/html' }),
      // we can't get a snippet out of the above that's useful.
      snipForwardedHtml = '',


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
          [bpartStraightASCII, bpartTrivialHtml]),
  // Multipart message with a text/plain body following an attachment;
      multipartAttachPlain = new $msggen.SyntheticPartMultiMixed([
        new $msggen.SyntheticPartLeaf("plaintext part 1"),
        new $msggen.SyntheticPartLeaf("something", {
          contentType: "image/png",
        }),
        new $msggen.SyntheticPartLeaf("plaintext part 3"),
      ]),

      multipartInlineImage = new $msggen.SyntheticPartMultiMixed([
        new $msggen.SyntheticPartLeaf("plaintext part 1"),
        new $msggen.SyntheticPartLeaf("something", {
          contentType: "image/png",
          disposition: "inline;\r\n" +
                       " filename=photo.JPG",
          contentId: null
        })
      ]),

      multipartInlineText = new $msggen.SyntheticPartMultiMixed([
        new $msggen.SyntheticPartLeaf("plaintext inline", {
          contentType: "text/plain",
          disposition: "inline",
          contentId: null
        })
      ]),

  // - attachments
      tachImageAsciiName = {
        filename: 'stuff.png',
        decodedFilename: 'stuff.png',
        contentType: 'image/png',
        encoding: 'base64', charset: null, format: null,
        body: 'YWJj\n'
      },
      tachImageMimeWordQuotedName = {
        filename: mwqSammySnake + '.png',
        decodedFilename: rawSammySnake + '.png',
        contentType: 'image/png',
        encoding: 'base64', charset: null, format: null,
        body: 'YWJj\n'
      },
      tachImageMimeWordBase64Name = {
        filename: mwbMultiBase64 + '.png',
        decodedFilename: rawMultiBase64 + '.png',
        contentType: 'image/png',
        encoding: 'base64', charset: null, format: null,
        body: 'YWJj\n'
      },
      tachImageMimeWordBase64EucKrName = {
        filename: '=?EUC-KR?B?waa48SC++LTCIMO3us4gxsTAzyAwMDQxOS5qcGc=?=',
        decodedFilename:
          '\uc81c\ubaa9 \uc5c6\ub294 \ucca8\ubd80 \ud30c\uc77c 00419.jpg',
        contentType: 'image/jpeg',
        encoding: 'base64', charset: null, format: null,
        body: 'YWJj\n'
      },
      // an attachment where the filename only comes from the continuation
      tachImageDispositionMimeWord = {
        disposition: "attachment;\r\n" +
' filename="=?UTF-8?B?7KCc66qpIOyXhuuKlCDssqjrtoAg7YyM7J28IDAwNDIyLmpwZw==?="',
        decodedFilename:
          '\uc81c\ubaa9 \uc5c6\ub294 \ucca8\ubd80 \ud30c\uc77c 00422.jpg',
        contentType: 'image/jpeg',
        encoding: 'base64', charset: null, format: null,
        body: 'YWJj\n'
      },
      tachImageDispositionCharsetContinuation = {
        disposition: "attachment;\r\n" +
" filename*0*=UTF-8''%EC%A0%9C%EB%AA%A9%20%EC%97%86%EB%8A%94%20%EC%B2%A8%EB;\r\n" +
" filename*1*=%B6%80%20%ED%8C%8C%EC%9D%BC%20%30%30%34%31%39%2E%6A%70%67",
        decodedFilename:
          '\uc81c\ubaa9 \uc5c6\ub294 \ucca8\ubd80 \ud30c\uc77c 00419.jpg',
        contentType: 'image/jpeg',
        encoding: 'base64', charset: null, format: null,
        body: 'YWJj\n'
      },
      // an attachment where the filename only comes from the content type
      tachImageContentTypeMimeWord = {
        contentTypeExtra: {
          name:
            '=?UTF-8?B?7KCc66qpIOyXhuuKlCDssqjrtoAg7YyM7J28IDAwNDE5LmpwZw==?=',
        },
        decodedFilename:
          '\uc81c\ubaa9 \uc5c6\ub294 \ucca8\ubd80 \ud30c\uc77c 00419.jpg',
        contentType: 'image/jpeg',
        encoding: 'base64', charset: null, format: null,
        body: 'YWJj\n'
      },
      tachImageContentTypeCharsetContinuation = {
        contentTypeExtra: {
          'name*0*': "UTF-8''%EC%A0%9C%EB%AA%A9%20%EC%97%86%EB%8A%94%20%EC%B2%A8%EB",
          'name*1*': "%B6%80%20%ED%8C%8C%EC%9D%BC%20%30%30%34%31%39%2E%6A%70%67",
        },
        decodedFilename:
          '\uc81c\ubaa9 \uc5c6\ub294 \ucca8\ubd80 \ud30c\uc77c 00419.jpg',
        contentType: 'image/jpeg',
        encoding: 'base64', charset: null, format: null,
        body: 'YWJj\n'
      },
      tachImageDoubleMimeWordName = {
        filename: mwqSammySnake + '-' + mwbMultiBase64 + '.png',
        decodedFilename: rawSammySnake + '-' + rawMultiBase64 + '.png',
        contentType: 'image/png',
        encoding: 'base64', charset: null, format: null,
        body: 'YWJj\n'
      };

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
      name: 'text/plain utf7',
      bodyPart: bpartUtf7Name,
      checkBody: rawUnicodeName,
    },
    {
      name: 'text/html utf7',
      bodyPart: bpartUtf7HtmlName,
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
    {
      name: 'proper period-stuffing works',
      bodyPart: new SyntheticPartLeaf(period),
      checkBody: period,
    },
    // verification that we don't insert random crap to join HTML nodes
    {
      name: 'joining html nodes doesn\'t produce extra crap (multipart)',
      bodyPart: new $msggen.SyntheticPartMultiMixed([
        new $msggen.SyntheticPartLeaf("HTML1", {contentType: "text/html"}),
        new $msggen.SyntheticPartLeaf("HTML2", {contentType: "text/html"}),
        new $msggen.SyntheticPartMultiMixed([
          new $msggen.SyntheticPartLeaf("HTML3", {contentType: "text/html"}),
          new $msggen.SyntheticPartLeaf("HTML4", {contentType: "text/html"}),
        ])
      ]),
      checkBody: 'HTML1',
      checkWholeBody: 'HTML1HTML2HTML3HTML4',
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
      name: 'text/html empty',
      bodyPart: bpartEmptyHtml,
      checkBody: bstrEmptyHtml,
    },
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
      name: 'text/html thunderbird forwarded',
      bodyPart: bpartForwardedHtml,
      checkBody: bstrSanitizedForwardedHtml,
      checkSnippet: snipForwardedHtml,
    },
    // - alternative chooses text/html
    {
      name: 'multipart/alternative choose text/html',
      bodyPart: alternHtml,
      checkBody: bstrSanitizedTrivialHtml,
    },
    // - text/plain with attachments
    {
      name: 'text/plain with ASCII attachment name',
      bodyPart: bpartQpFlowed,
      checkBody: rawFlowed,
      attachments: [tachImageAsciiName],
    },
    {
      name: 'text/plain with QP mime-word attachment name',
      bodyPart: bpartQpFlowed,
      checkBody: rawFlowed,
      attachments: [tachImageMimeWordQuotedName],
    },
    {
      name: 'text/plain with base64 mime-word attachment name',
      bodyPart: bpartQpFlowed,
      checkBody: rawFlowed,
      attachments: [tachImageMimeWordBase64Name],
    },
    {
      name: 'text/plain with base64 mime-word euc-kr attachment name',
      bodyPart: bpartQpFlowed,
      checkBody: rawFlowed,
      attachments: [tachImageMimeWordBase64EucKrName],
    },
    {
      name: 'text/plain with utf-8 fn via content-disposition mime-word',
      bodyPart: bpartQpFlowed,
      checkBody: rawFlowed,
      attachments: [tachImageDispositionMimeWord],
    },
    {
      name: 'text/plain with utf-8 fn via disposition charset continuation',
      bodyPart: bpartQpFlowed,
      checkBody: rawFlowed,
      attachments: [tachImageDispositionCharsetContinuation],
    },
    {
      name: 'text/plain with utf-8 name via content-type mime-word',
      bodyPart: bpartQpFlowed,
      checkBody: rawFlowed,
      attachments: [tachImageContentTypeMimeWord],
    },
    {
      name: 'text/plain with utf-8 name via content-type charset continuation',
      bodyPart: bpartQpFlowed,
      checkBody: rawFlowed,
      attachments: [tachImageContentTypeCharsetContinuation],
    },
    {
      name: 'text/plain with multiple mime words in the attachment name',
      bodyPart: bpartQpFlowed,
      checkBody: rawFlowed,
      attachments: [tachImageDoubleMimeWordName],
    },
    {
      name: 'Multipart/mixed reordered snippet generation',
      bodyPart: multipartAttachPlain,
      checkBody: "plaintext part 1",
      checkSnippet: "plaintext part 1",
    },
    {
      name: 'Multipart/mixed inline images without content-id',
      bodyPart: multipartInlineImage,
      checkBody: '',
      createAttachment: true
    },
    {
      name: 'Multipart/mixed inline text without content-id',
      bodyPart: multipartInlineText,
      checkBody: 'plaintext inline',
      checkSnippet: 'plaintext inline',
    }
  ];

  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse,
                              restored: true }),
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
        msgGen = new $msggen.MessageGenerator(testUniverse._useDate);

    for (var i = 0; i < testMessages.length; i++) {
      var msgDef = testMessages[i];
      msgDef.age = { days: 1, hours: i };
      messageAppends.push(msgGen.makeMessage(msgDef));
    }

    return messageAppends;
  }, { messageCount: testMessages.length }); // give count for timeout purposes

  T.group('full message download');
  // -- open the folder
  var folderView1 = testAccount.do_openFolderView(
    'full download view', fullSyncFolder,
    { count: testMessages.length, full: testMessages.length, flags: 0,
      deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true,
      expectFunc: function() {
        if (testAccount.type === 'pop3') {
          fullSyncFolder.connActor.ignore_savedAttachment();
          fullSyncFolder.connActor.ignore_saveFailure();
        }
      }});

  // -- check each message in its own step
  function checkMessage(folderView, msgDef, iMsg) {
    T.check(eCheck, msgDef.name, function() {
      if (!msgDef.createAttachment)
        eCheck.expect_namedValue('body', msgDef.checkBody);
      if (msgDef.checkSnippet)
        eCheck.expect_namedValue('snippet', msgDef.checkSnippet);
      if (msgDef.checkWholeBody) {
        eCheck.expect_namedValue('wholeBody', msgDef.checkWholeBody);
      }
      // This test case doesn't quite fit into the general model,
      // since it is supposed to force an inline image to an attachment
      if (msgDef.createAttachment) {
        eCheck.expect_namedValue('attachment-name', 'photo.JPG');
      }
      if ('attachments' in msgDef) {
        for (var i = 0; i < msgDef.attachments.length; i++) {
          eCheck.expect_namedValue('attachment-name',
                                   msgDef.attachments[i].decodedFilename);
          if (testAccount.type !== 'pop3') {
            // since POP3 always downloads the entire attachment and
            // it reports the after-base64-decoding size rather than
            // the raw transfer size in bytes, just skip this test.
            eCheck.expect_namedValue('attachment-size',
                                     msgDef.attachments[i].body.length);
          }
        }
      }
      var header = folderView.slice.items[iMsg];
      header.getBody({ withBodyReps: true }, function(body) {

        var bodyValue;
        if (!body.bodyReps.length) {
          bodyValue = '';
        }
        else if (body.bodyReps[0].type === 'plain') {
          if (!body.bodyReps[0].content) {
            bodyValue = '';
          } else {
            bodyValue = body.bodyReps[0].content[1] || '';
          }
        }
        else if (body.bodyReps[0].type === 'html') {
          bodyValue = body.bodyReps[0].content;
        }

        if (!msgDef.createAttachment)
          eCheck.namedValue('body', bodyValue);

        if (msgDef.checkWholeBody) {
          eCheck.namedValue('wholeBody', body.bodyReps.reduce(function(s, rep) {
            if (rep.type === 'html' || rep.type === 'plain') {
              return s + rep.content;
            } else {
              return s;
            }
          }, ''));
        }
        if (msgDef.checkSnippet)
          eCheck.namedValue('snippet', header.snippet);

        if (('attachments' in msgDef || msgDef.createAttachment )
          && body.attachments && body.attachments.length) {
          for (var i = 0; i < body.attachments.length; i++) {
            eCheck.namedValue('attachment-name', body.attachments[i].filename);
            if (testAccount.type !== 'pop3' && !msgDef.createAttachment) {
              eCheck.namedValue('attachment-size',
                                body.attachments[i].sizeEstimateInBytes);
            }
          }
        }
        body.die();
      });
    });
  }
  testMessages.forEach(checkMessage.bind(null, folderView1));
  // The re-creation will reset the slice, so we could try and just keep using
  // this slice, but we'd need to change the sync settings to match our explicit
  // open call up above.
  testAccount.do_closeFolderView(folderView1);

  T.group('reset folder state');
  if (testAccount.type !== 'pop3') {
    // for pop3, we don't want to blow away the entire folder becuase
    // that's our only state for local folders
    testAccount.do_recreateFolder(fullSyncFolder);
  }

  T.group('snippet fetch followed by full message download');
  // sync
  var folderView2 = testAccount.do_openFolderView(
    'snippet download view', fullSyncFolder,
    { count: testMessages.length, full: testMessages.length, flags: 0,
      deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });
  // request up to 4k of partial bodies for all messages!
  T.action(eCheck, 'fetch body snippets', function() {
    eCheck.expect_event('got snippets');
    folderView2.slice.maybeRequestBodies(
      0, folderView2.slice.items.length,
      { maximumBytesToFetch: 4096 },
      function() {
        eCheck.event('got snippets');
    });
  });

  // same exact thing as above, but it will automatically only fetch the extra
  // data needed
  testMessages.forEach(checkMessage.bind(null, folderView2));

  T.group('cleanup');
});

}); // end define

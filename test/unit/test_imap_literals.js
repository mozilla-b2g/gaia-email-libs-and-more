/**
 * Test IMAP literal handling when injected in strange places.
 *
 * Some IMAP servers will respond to a FETCH request with a header
 * that contains a literal. Parsing code needs to properly handle
 * that case.
 *
 * These tests cover this case in two ways: by checking that IMAP's
 * parseExpr() function parses literals correctly, and by ensuring
 * that a valid FETCH response doesn't destroy the IMAP parser's
 * state.
 **/

define(['rdcommon/testcontext', './resources/th_main',
        './resources/fault_injecting_socket',
        '../../data/lib/imap.js',
        'exports'],
       function($tc, $th_imap, $fawlty, $imapParser, exports) {
var FawltySocketFactory = $fawlty.FawltySocketFactory;

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_imap_literals' }, null, [$th_imap.TESTHELPER], ['app']);


// Hacky helpers for getting ImapProtoConn loggers.  We haven't done this
// previously because setting expectations on protocol connections will tend to
// be laborious and horrible.
function captureImapProtoConns(T, RT) {
  var soup = {};
  T.setup('Listen for ImapProtoConns', function() {
    RT.captureAllLoggersByType('ImapProtoConn', soup);
  });
  return soup;
}

function do_gimmeImapProtoConn(T, RT, soup, name) {
  var actor = T.actor('ImapProtoConn', name);
  T.setup('grab ImapProtoConn handle', function() {
    for (var key in soup) {
      var logger = soup[key];
      actor.__attachToLogger(logger);
      return;
    }
    throw new Error('Failed to find logger!');
  });
  return actor;
}

var restored = false;
/**
 * Hack to create a test case where we can have the back-end issue a FETCH
 * command and have it not get upset that we are using a hard-coded response.
 * The actual FETCH response we tell imap.js is completely inconsistent with
 * what it asks for, but imap.js doesn't care.  We do generate correct
 * expectations against what the ImapProtoConn log will generate, however, so
 * parser regressions that don't break the state machine should still be
 * detected.
 */
var createFetchResponseTestCase = function(fetchData, splitExpectAfter) {
  return function (T, RT) {
    T.group('setup');
    var imapProtoConnSoup = captureImapProtoConns(T, RT);
    var testUniverse = T.actor('testUniverse', 'U');
    var testAccount = T.actor('testAccount', 'A',
                              { universe: testUniverse, restored: restored });
    // account creation results in a higher tag
    var expectedTag = restored ? 'A9' : 'A14';
    restored = true;
    var eCheck = T.lazyLogger('check');

    var testFolder = testAccount.do_createTestFolder(
      'test_imap_literals',
      { count: 1, age: { days: 0 }, age_incr: { days: 1 } });

    var folderView = testAccount.do_openFolderView(
      'sync', testFolder,
      null,
      null,
      { syncedToDawnOfTime: true });

    var imapProtoConn = do_gimmeImapProtoConn(T, RT, imapProtoConnSoup, 'P');

    T.group('fetch response');
    T.action('queue up SYNC to return something', eCheck, imapProtoConn,
             function() {
      // the connection is already established because we created a folder.
      var socket = FawltySocketFactory.getMostRecentLiveSocket();
      socket.doOnSendText([{
        match: /FETCH/,
        actions: [{cmd: 'fake-receive',
                   data: fetchData
                  }]
      }]);

      imapProtoConn.expect_cmd_begin(
        expectedTag, 'UID FETCH', '1 (UID FLAGS INTERNALDATE BODY.PEEK[1])');
      var idxSplit = fetchData.indexOf(splitExpectAfter) +
                     splitExpectAfter.length;
      imapProtoConn.expect_data(fetchData.substring(0, idxSplit));
      // the CRLF does not get reported
      imapProtoConn.expect_data(fetchData.substring(idxSplit + 2));

      eCheck.expect_namedValue('fires callback', false);
      folderView.slice.maybeRequestBodies(0, 1, function() {
        eCheck.namedValue('fires callback', false);
        socket.doNow(['instant-close']);
      });
    });
    T.group('cleanup');
    T.cleanup('kill sockets', function() {
      FawltySocketFactory.reset();
    });
  };
};


// fetch string for the below cases, we replace %%%TESTPART%%% in our actual
// tests.
var BASE_FETCH_STRING =
  '* 1 FETCH (UID 6 FLAGS (\\Seen) INTERNALDATE "16-Aug-2013 14:34:45 -0700" BODYSTRUCTURE (("text" "plain" ("charset" "ISO-8859-1" "format" "flowed") NIL NIL "7bit" 1299 35 NIL NIL NIL NIL)(("text" "html" ("charset" "ISO-8859-1") NIL NIL "7bit" 1969 45 NIL NIL NIL NIL)("text" "html" ("charset" "utf-8" "name" "kRDKpkSiVb") "<part6.05080103.02080505@mozilla.com>" NIL "base64" 52762 713 NIL ("inline" ("filename" "kRDKpkSiVb")) NIL %%%TESTPART%%%) "related" ("boundary" "------------020708090808000005090702") NIL NIL NIL) "alternative" ("boundary" "------------090003090100040203090803") NIL NIL NIL) BODY[HEADER.FIELDS (FROM TO CC BCC SUBJECT REPLY-TO MESSAGE-ID REFERENCES)] {177}\r\n' +
  'Message-ID: <51F6D587.9010906@mozilla.com>\r\n' +
  'From: Nick Desaulniers <ndesaulniers@mozilla.com>\r\n' +
  'To: undisclosed-recipients:;\r\n' +
  'Subject: 19(8/4) Day to Protest NSA Surveillance\r\n\r\n)\r\n';
var BASE_SPLIT = '{177}';

// In this common case, the FETCH response is normal.
TD.commonCase(
  'standard fetch response header, full-stack',
  createFetchResponseTestCase(
    BASE_FETCH_STRING.replace(
      '%%%TESTPART%%%',
      '"https://www.dropbox.com/sh/q69208agr1xiqa2/kRDKpkSiVb"'),
    BASE_SPLIT));

// This exceptional case can occur when the server splits the header
// with a literal in the middle. This should also parse correctly.
TD.commonCase(
  'literal with LF in the middle of a fetch response header, full-stack',
  createFetchResponseTestCase(
    BASE_FETCH_STRING.replace(
      '%%%TESTPART%%%',
      '{57}\r\n' +
        '"https://www.dropbox.com/sh/q69208agr1x\n' +
	'\tiqa2/kRDKpkSiVb"'),
    BASE_SPLIT));

// The above \n example is a real thing we saw; this \r\n is not something we've
// seen, but it is a legal use of a literal, so we want to test this code-path
// too.
TD.commonCase(
  'literal with CRLF in the middle of a fetch response header, full-stack',
  createFetchResponseTestCase(
    BASE_FETCH_STRING.replace(
      '%%%TESTPART%%%',
      '{58}\r\n' +
        '"https://www.dropbox.com/sh/q69208agr1x\r\n' +
	'\tiqa2/kRDKpkSiVb"'),
    BASE_SPLIT));

// In this common case, the FETCH response is normal.
TD.commonCase('simple parseExpr sanity check', function (T) {
  var eLazy = T.lazyLogger('check');
  T.action(eLazy, 'simple parsing', function() {
    eLazy.expect_namedValue('result', $imapParser.parseExpr("FOO {6}\r\nabc\nde BAR"));

    eLazy.namedValue('result', [
      "FOO",
      "abc\nde",
      "BAR"
    ]);
  });
});

TD.commonCase('advanced parseExpr sanity check', function (T) {
  var eLazy = T.lazyLogger('check');
  T.action(eLazy, 'full header parsing with literal', function() {
    eLazy.expect_namedValue('result', $imapParser.parseExpr("UID 6 FLAGS (\\Seen) INTERNALDATE \"16-Aug-2013 14:34:45 -0700\" BODYSTRUCTURE ((\"text\" \"plain\" (\"charset\" \"ISO-8859-1\" \"format\" \"flowed\") NIL NIL \"7bit\" 1299 35 NIL NIL NIL NIL)((\"text\" \"html\" (\"charset\" \"ISO-8859-1\") NIL NIL \"7bit\" 1969 45 NIL NIL NIL NIL)(\"text\" \"html\" (\"charset\" \"utf-8\" \"name\" \"kRDKpkSiVb\") \"<part6.05080103.02080505@mozilla.com>\" NIL \"base64\" 52762 713 NIL (\"inline\" (\"filename\" \"kRDKpkSiVb\")) NIL {57}\r\n\"https://www.dropbox.com/sh/q69208agr1x\n\tiqa2/kRDKpkSiVb\") \"related\" (\"boundary\" \"------------020708090808000005090702\") NIL NIL NIL) \"alternative\" (\"boundary\" \"------------090003090100040203090803\") NIL NIL NIL) BODY[HEADER.FIELDS (FROM TO CC BCC SUBJECT REPLY-TO MESSAGE-ID REFERENCES)] {177}"));

    eLazy.namedValue('result', [
      "UID",6,
      "FLAGS",["\\Seen"],
      "INTERNALDATE","16-Aug-2013 14:34:45 -0700","BODYSTRUCTURE",
      [["text","plain",["charset","ISO-8859-1","format","flowed"],null,null,"7bit",1299,35,null,null,null,null],
       [["text","html",["charset","ISO-8859-1"],null,null,"7bit",1969,45,null,null,null,null],
        ["text","html",["charset","utf-8","name","kRDKpkSiVb"],"<part6.05080103.02080505@mozilla.com>",
         null,"base64",52762,713,null,["inline",["filename","kRDKpkSiVb"]],null,
         "https://www.dropbox.com/sh/q69208agr1x\n\tiqa2/kRDKpkSiVb"],"related",
        ["boundary","------------020708090808000005090702"],null,null,null],"alternative",
       ["boundary","------------090003090100040203090803"],null,null,null],
      ["HEADER.FIELDS",["FROM","TO","CC","BCC","SUBJECT","REPLY-TO","MESSAGE-ID","REFERENCES"]],"{177}"]);
  });
});

}); // end define

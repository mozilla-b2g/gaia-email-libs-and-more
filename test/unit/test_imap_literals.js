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

var restored = false;
var createFetchResponseTestCase = function(fetchData) {
  return function (T) {
    T.group('setup');
    var testUniverse = T.actor('testUniverse', 'U');
    var testAccount = T.actor('testAccount', 'A',
                              { universe: testUniverse, restored: restored });
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

    T.group('fetch response');
    T.action('queue up SYNC to return something', eCheck, function() {
      // the connection is already established because we created a folder.
      var socket = FawltySocketFactory.getMostRecentLiveSocket();
      socket.doOnSendText([{
        match: /FETCH/,
        actions: [{cmd: 'fake-receive',
                   data: fetchData
                  }]
      }]);
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
  }
};


// In this common case, the FETCH response is normal.
TD.commonCase('standard fetch response header, full-stack',
              createFetchResponseTestCase(
                '* 1 FETCH (UID 6 FLAGS (\\Seen) INTERNALDATE "16-Aug-2013 14:34:45 -0700" BODYSTRUCTURE (("text" "plain" ("charset" "ISO-8859-1" "format" "flowed") NIL NIL "7bit" 1299 35 NIL NIL NIL NIL)(("text" "html" ("charset" "ISO-8859-1") NIL NIL "7bit" 1969 45 NIL NIL NIL NIL)("text" "html" ("charset" "utf-8" "name" "kRDKpkSiVb") "<part6.05080103.02080505@mozilla.com>" NIL "base64" 52762 713 NIL ("inline" ("filename" "kRDKpkSiVb")) NIL "https://www.dropbox.com/sh/q69208agr1xiqa2/kRDKpkSiVb") "related" ("boundary" "------------020708090808000005090702") NIL NIL NIL) "alternative" ("boundary" "------------090003090100040203090803") NIL NIL NIL) BODY[HEADER.FIELDS (FROM TO CC BCC SUBJECT REPLY-TO MESSAGE-ID REFERENCES)] {177}\r\n' +
                  'Message-ID: <51F6D587.9010906@mozilla.com>\r\n' +
                  'From: Nick Desaulniers <ndesaulniers@mozilla.com>\r\n' +
                  'To: undisclosed-recipients:;\r\n' +
                  'Subject: 19(8/4) Day to Protest NSA Surveillance\r\n\r\n)\r\n'));

// This exceptional case can occur when the server splits the header
// with a literal in the middle. This should also parse correctly.
TD.commonCase('literal in the middle of a fetch response header, full-stack',
              createFetchResponseTestCase(
                '* 1 FETCH (UID 6 FLAGS (\\Seen) INTERNALDATE "16-Aug-2013 14:34:45 -0700" BODYSTRUCTURE (("text" "plain" ("charset" "ISO-8859-1" "format" "flowed") NIL NIL "7bit" 1299 35 NIL NIL NIL NIL)(("text" "html" ("charset" "ISO-8859-1") NIL NIL "7bit" 1969 45 NIL NIL NIL NIL)("text" "html" ("charset" "utf-8" "name" "kRDKpkSiVb") "<part6.05080103.02080505@mozilla.com>" NIL "base64" 52762 713 NIL ("inline" ("filename" "kRDKpkSiVb")) NIL {57}\r\n' +
'"https://www.dropbox.com/sh/q69208agr1x\n' +
	                '\tiqa2/kRDKpkSiVb") "related" ("boundary" "------------020708090808000005090702") NIL NIL NIL) "alternative" ("boundary" "------------090003090100040203090803") NIL NIL NIL) BODY[HEADER.FIELDS (FROM TO CC BCC SUBJECT REPLY-TO MESSAGE-ID REFERENCES)] {177}\r\n' +
                  'Message-ID: <51F6D587.9010906@mozilla.com>\r\n' +
                  'From: Nick Desaulniers <ndesaulniers@mozilla.com>\r\n' +
                  'To: undisclosed-recipients:;\r\n' +
                  'Subject: 19(8/4) Day to Protest NSA Surveillance\r\n\r\n)\r\n'));


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

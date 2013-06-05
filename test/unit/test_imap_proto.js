/**
 * IMAP protocol implementation tests.  Really I'm just creating this for
 * the modified utf-7 decoding test.
 */

define(['rdcommon/testcontext', './resources/th_main', 'imap', 'exports'],
       function($tc, $th_imap, $imap, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_imap_proto' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonSimple('decodeModifiedUtf7', function(lazy) {
  var decodeModifiedUtf7 = $imap.decodeModifiedUtf7;

  function check(encoded, expected) {
    lazy.expect_namedValue(encoded, expected);
    lazy.namedValue(encoded, decodeModifiedUtf7(encoded));
  }

  check('&-', '&');
  check('&AO4-', '\u00ee');
  check('&AOk-', '\u00e9');
  check('foo &AO4- bar &AOk- baz', 'foo \u00ee bar \u00e9 baz');
  check('foo&AO4-bar&AOk-baz', 'foo\u00eebar\u00e9baz');
  // from RFC3501
  check('~peter/mail/&U,BTFw-/&ZeVnLIqe-',
        '~peter/mail/\u53f0\u5317/\u65e5\u672c\u8a9e');
});

TD.commonSimple('parseImapDateTime', function(lazy) {
  function check(str, expectedTimestamp) {
    var parsedTS = $imap.parseImapDateTime(str);

    lazy.expect_namedValue(str, expectedTimestamp);
    lazy.namedValue(str, parsedTS);
  }

  // remember! dates are zero-based!

  // handle "space digit" for day number
  check(' 4-Jun-2013 14:15:49 -0500',
        Date.UTC(2013, 5, 4, 19, 15, 49));
  // handle "digit" for day number (we may get trimmed)
  check('4-Jun-2013 14:15:49 -0500',
        Date.UTC(2013, 5, 4, 19, 15, 49));
  // handle digit digit
  check('04-Jun-2013 14:15:49 -0500',
        Date.UTC(2013, 5, 4, 19, 15, 49));
  check('14-Jun-2013 14:15:49 -0500',
        Date.UTC(2013, 5, 14, 19, 15, 49));
});

}); // end define

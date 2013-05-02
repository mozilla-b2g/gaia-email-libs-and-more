/**
 * IMAP protocol implementation tests.  Really I'm just creating this for
 * the modified utf-7 decoding test.
 */

define(['rdcommon/testcontext', './resources/th_main', 'exports'],
       function($tc, $th_imap, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_imap_proto' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonSimple('decodeModifiedUtf7', function(lazy) {
  var decodeModifiedUtf7 = require('imap').decodeModifiedUtf7;

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

}); // end define

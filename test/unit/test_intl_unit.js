define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var mimefuncs = require('mimefuncs');

/**
 * Run some encodings that actually exist but are unsupported by us /
 * TextDecoder / the internet at large.  What we want to check here is:
 * - That we don't throw an exception on seeing these things.
 * - That we fall back to using utf-8 and see a correctly incorrect
 *   interpretation of the encoded text.
 */
return new LegacyGelamTest('unsupported bad news encodings', function(T, RT) {
  var cases = [
    {
      name: 'iso-2022-cn (replacement encoder) (7-bit example)',
      encoding: 'iso-2022-cn',
      // from http://tools.ietf.org/html/rfc1922 1.2
      input: '\x1b$)A\x0e=;;;\x1b$)GG(_P\x0f',
      reallyEncodes: '\u4ea4\u6362\u4ea4\u63db',
      // Decode it the same as the input since it's 7-bit and therefore won't
      // result in non-ASCII or unicode replacement characters.
      weWant: '\x1b$)A\x0e=;;;\x1b$)GG(_P\x0f',
    },
    {
      name: 'gibberish encoding',
      encoding: 'i-am-a-tomato',
      input: 'TOMATO!',
      reallyEncodes: null,
      weWant: 'TOMATO!',
    }
  ];

  var eCheck = T.lazyLogger('check');
  cases.forEach(function(info) {
    T.action(eCheck, info.name, function() {
      eCheck.expect('converted',  info.weWant);
      var outstr = new TextDecoder('utf-8').decode(
        mimefuncs.charset.convert(info.input, info.encoding));
      eCheck.log('converted', outstr);
    });
  });
});

}); // end define

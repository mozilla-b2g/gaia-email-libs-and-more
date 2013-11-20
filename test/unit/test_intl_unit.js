define(['rdcommon/testcontext', './resources/th_main',
        'encoding', 'exports'],
       function($tc, $th_main, $encoding,
                exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_intl_unit' }, null,
  [$th_main.TESTHELPER], ['app']);

TD.commonSimple('encoding aliases', function(eLazy) {
  var aliases = [
    ['latin1', 'iso-8859-1'], // TextDecoder actually understands latin1...
    ['latin-1', 'iso-8859-1'], // but not these.
    ['latin_1', 'iso-8859-1'],
    ['latin2', 'iso-8859-2'], // TextDecoder actually understands latin2...
    ['latin-2', 'iso-8859-2'], // but not these.
    ['latin_2', 'iso-8859-2'],
    ['ms949', 'windows-949'],
    ['MS949', 'windows-949'],
    ['win949', 'windows-949'],
    ['win-949', 'windows-949'],
  ];

  var i, alias;
  for (i = 0; i < aliases.length; i++) {
    alias = aliases[i];
    eLazy.expect_namedValue(alias[0], alias[1]);
  }
  for (i = 0; i < aliases.length; i++) {
    alias = aliases[i];
    eLazy.namedValue(alias[0], $encoding.checkEncoding(alias[0]));
  }
});

/**
 * Run some encodings that actually exist but are unsupported by us /
 * TextDecoder / the internet at large.  What we want to check here is:
 * - That we don't throw an exception on seeing these things.
 * - That we fall back to using utf-8 and see a correctly incorrect
 *   interpretation of the encoded text.
 */
TD.commonCase('unsupported bad news encodings', function(T, RT) {
  $th_main.thunkConsoleForNonTestUniverse();
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
      eCheck.expect_namedValue('converted', info.weWant);
      var outstr = $encoding.convert(info.input, 'utf-8', info.encoding);
      eCheck.namedValue('converted', outstr);
    });
  });
});

}); // end define

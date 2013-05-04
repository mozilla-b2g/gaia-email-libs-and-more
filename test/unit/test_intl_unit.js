define(['rdcommon/testcontext',
        'encoding', 'exports'],
       function($tc, $encoding,
                exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_intl_unit' }, null,
  [], ['app']);

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

}); // end define

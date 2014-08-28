/**
 * Test our rfc2822-specialized base64 encoder.
 **/
define([
  'rdcommon/testcontext',
  'safe-base64',
  'exports'
], function($tc, base64, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_b64_unit' }, null,
  [], ['app']);

TD.commonCase('base64 encoding', function(T, RT) {
  var eCheck = T.lazyLogger('check');

  /**
   * Create a uint8array full of the given range of data.
   */
  function makeU8Range(low, count) {
    var arr = [], cur = low;
    while(count--) {
      arr.push((cur++) % 256);
    }
    return new Uint8Array(arr);
  }

  /**
   * Create the expected base64 string for the given range.  This is from our
   * prior, memory-hungry implementation.  Also, I checked the results of the
   * unit test log output to make sure I didn't screw up too bad.
   */
  function correctB64Range(low, count) {
    if (count === 0)
      return '';
    var s = '', cur = low;
    while(count--) {
      s += String.fromCharCode((cur++) % 256);
    }
    var encoded = btoa(s).replace(/.{76}/g,"$&\r\n");
    if (!/\r\n$/.test(encoded))
      encoded += '\r\n';
    return encoded;
  }

  // Here are a bunch of cases that I, a mighty human, superior to machines
  // and their pitiful brute-forcing, have selected.
  var cases = [
    {
      name: 'zero-length',
      low: 0,
      count: 0,
    },
    {
      name: '1 byte',
      low: 0,
      count: 1
    },
    {
      name: '2 bytes',
      low: 1,
      count: 2
    },
    {
      name: '3 bytes',
      low: 3,
      count: 3
    },
    {
      name: '4 bytes',
      low: 6,
      count: 4
    },
    {
      name: '5 bytes',
      low: 0,
      count: 5
    },
    {
      name: '6 bytes',
      low: 0,
      count: 6
    },
    {
      name: '1 line: 57 bytes',
      low: 10,
      count: 57
    },
    {
      name: '1 line plus 1 byte: 58 bytes',
      low: 67,
      count: 58
    },
    {
      name: 'almost 2 lines: 57 + 56',
      low: 100,
      count: 57 + 56
    },
    {
      name: '2 lines: 57 * 2',
      low: 200,
      count: 57 * 2
    },
    {
      name: '2 lines plus 1 byte: 57 + 57 + 1',
      low: 1,
      count: 57 + 57 + 1
    },
    {
      name: 'all of the numbers!',
      low: 0,
      count: 256
    }
  ];

  var asciiDecoder = new TextDecoder('ascii');

  cases.forEach(function(tc) {
    T.check(eCheck, tc.name, function() {
      var correctEncoding = correctB64Range(tc.low, tc.count);
      eCheck.expect_namedValue('encoded', correctEncoding);

      var u8Input = makeU8Range(tc.low, tc.count);
      var actualU8Encoding = base64.mimeStyleBase64Encode(u8Input);
      var actualEncoding = asciiDecoder.decode(actualU8Encoding);
      eCheck.namedValue('encoded', actualEncoding);
    });
  });
});

}); // end define

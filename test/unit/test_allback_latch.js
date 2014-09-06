define(['rdcommon/testcontext',
        'allback', 'exports'],
       function($tc, allback,
                exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_allback_latch' }, null,
  [], ['app']);

var latchedWithRejections = allback.latchedWithRejections;

// Test that a simple latch works as intended.
TD.commonSimple('basic latch', function(eLazy) {
  var latch = allback.latch();

  latch.defer('one')('result1');
  latch.defer('two')('result2');
  latch.defer()('no key in results');
  eLazy.expect_namedValue('one', 'result1');
  eLazy.expect_namedValue('two', 'result2');
  latch.then(function(results) {
    for (var k in results) {
      eLazy.namedValue(k, results[k][0]);
    }
  });
});

TD.commonSimple('latchedWithRejections', function(eLazy) {

  eLazy.expect_namedValue(
    'empty',
    {});
  eLazy.expect_namedValue(
    'one success',
    {
      a: { resolved: true, value: 'A' }
    });
  eLazy.expect_namedValue(
    'one failure',
    {
      b: { resolved: false, value: 'b' }
    });
  eLazy.expect_namedValue(
    'one success, one failure',
    {
      c: { resolved: true, value: 'C' },
      d: { resolved: false, value: 'd' }
    });


  latchedWithRejections({
  }).then(eLazy.namedValue.bind(null, 'empty'));

  latchedWithRejections({
    a: Promise.resolve('A')
  }).then(eLazy.namedValue.bind(null, 'one success'));

  latchedWithRejections({
    b: Promise.reject('b')
  }).then(eLazy.namedValue.bind(null, 'one failure'));

  latchedWithRejections({
    c: Promise.resolve('C'),
    d: Promise.reject('d')
  }).then(eLazy.namedValue.bind(null, 'one success, one failure'));
});


}); // end define

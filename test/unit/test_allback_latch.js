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

TD.commonSimple('extract error results', function(eLazy) {
  eLazy.expect_namedValueD('no errors', null);
  eLazy.expect_namedValueD('one error', 'justme');
  eLazy.expect_namedValueD('first error of two', 'one');

  var latchNoErrors = allback.latch();
  latchNoErrors.defer('one')(null);
  latchNoErrors.defer('two')(null);

  var latchOneError = allback.latch();
  latchOneError.defer('one')(null);
  latchOneError.defer('two')('justme');

  var latchTwoErrors = allback.latch();
  latchTwoErrors.defer('one')('one');
  latchTwoErrors.defer('two')('two');

  latchNoErrors.then(function(results) {
    eLazy.namedValueD('no errors',
                      allback.extractErrFromCallbackArgs(results),
                      results);
  });

  latchOneError.then(function(results) {
    eLazy.namedValueD('one error',
                      allback.extractErrFromCallbackArgs(results),
                      results);
  });

  // Note that objects maintain their ordering although the caller arguably
  // should probably avoid depending on this a bit.
  latchTwoErrors.then(function(results) {
    eLazy.namedValueD('first error of two',
                      allback.extractErrFromCallbackArgs(results),
                      results);
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

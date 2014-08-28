define(['rdcommon/testcontext',
        'allback', 'exports'],
       function($tc, allback,
                exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_allback_latch' }, null,
  [], ['app']);

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

}); // end define

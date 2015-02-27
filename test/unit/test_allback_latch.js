define(function(require, exports) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var allback = require('allback');

var latchedWithRejections = allback.latchedWithRejections;

// Test that a simple latch works as intended.
return [

new LegacyGelamTest('basic latch', function(T) {
  var latch = allback.latch();
  var eLazy = T.lazyLogger('lazy');

  T.action(function() {
    latch.defer('one')('result1');
    latch.defer('two')('result2');
    latch.defer()('no key in results');
    eLazy.expect('one',  'result1');
    eLazy.expect('two',  'result2');
    latch.then(function(results) {
      for (var k in results) {
        eLazy.log(k, results[k][0]);
      }
    });
  });
}),

new LegacyGelamTest('extract error results', function(T) {
  var eLazy = T.lazyLogger('lazy');

  T.action(function() {
    eLazy.expect('no errors',  null);
    eLazy.expect('one error',  'justme');
    eLazy.expect('first error of two',  'one');

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
      eLazy.log('no errors',
                allback.extractErrFromCallbackArgs(results),
                results);
    });

    latchOneError.then(function(results) {
      eLazy.log('one error',
                allback.extractErrFromCallbackArgs(results),
                results);
    });

    // Note that objects maintain their ordering although the caller arguably
    // should probably avoid depending on this a bit.
    latchTwoErrors.then(function(results) {
      eLazy.log('first error of two',
                allback.extractErrFromCallbackArgs(results),
                results);
    });
  });
}),


new LegacyGelamTest('latchedWithRejections', function(T) {
  var eLazy = T.lazyLogger('lazy');

  T.action(function() {
    eLazy.expect(
      'empty', {});
    eLazy.expect(
      'one success', {
        a: { resolved: true, value: 'A' }
      });
    eLazy.expect(
      'one failure', {
        b: { resolved: false, value: 'b' }
      });
    eLazy.expect(
      'one success, one failure', {
        c: { resolved: true, value: 'C' },
        d: { resolved: false, value: 'd' }
      });


    latchedWithRejections({
    }).then(eLazy.log.bind(eLazy, 'empty'));

    latchedWithRejections({
      a: Promise.resolve('A')
    }).then(eLazy.log.bind(eLazy, 'one success'));

    latchedWithRejections({
      b: Promise.reject('b')
    }).then(eLazy.log.bind(eLazy, 'one failure'));

    latchedWithRejections({
      c: Promise.resolve('C'),
      d: Promise.reject('d')
    }).then(eLazy.log.bind(eLazy, 'one success, one failure'));
  });
})

];

}); // end define

define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');

return new LegacyGelamTest('just authenticate', function(T, RT) {
  var TEST_PARAMS = RT.envOptions;

  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A',
                            { universe: testUniverse,
                              // for ActiveSync we want to support using something
                              // other than the default args, and we indeed only
                              // use them is we set realAccountNeeded, so do this.
                              realAccountNeeded: !TEST_PARAMS.defaultArgs });

  T.group('START GROUP');
  T.action('START ACTION', function() {
    var logger = T.lazyLogger();
    logger.expect('hello');
    setTimeout(function() {
      logger.log('hello');
    }, 500);
  });
  T.group('START GROUP 2');

  console.log('at end');
});

}); // end define

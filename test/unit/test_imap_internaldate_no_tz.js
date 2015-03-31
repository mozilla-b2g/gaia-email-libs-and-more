/**
 * net-c.com/netc.fr doesn't provide a timezone with its INTERNALDATE value in
 * response to FETCH requests.  Verify that we handle this without dying,
 * treating no timezone as equivalent to +0000.
 **/

define(function(require, exports) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');

return new LegacyGelamTest('basic sync succeeds', function(T, RT) {
  T.group('setup');

  var testUniverse = T.actor('TestUniverse', 'U');
  var testAccount = T.actor(
    'TestAccount', 'A',
    {
      universe: testUniverse,
      imapExtensions: ['NO_INTERNALDATE_TZ']
    });

  // Make sure that our test infrastructure is properly running this test
  T.check('ensure server variant', function() {
    if (testAccount.testServer.imapExtensions.indexOf('NO_INTERNALDATE_TZ') ===
        -1) {
      throw new Error(
        'This test demands that the server be NO_INTERNALDATE_TZ');
    }
  });

  T.group('sync');
  var saturatedFolder = testAccount.do_createTestFolder(
    'test_internaldate_no_tz',
    { count: 5, age: { days: 1 }, age_incr: { days: 1 }, age_incr_every: 1 });
  testAccount.do_viewFolder(
    'syncs', saturatedFolder,
    { count: 5, full: 5, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: null },
    { syncedToDawnOfTime: true });

  T.group('cleanup');
});

});

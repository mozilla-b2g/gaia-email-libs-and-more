/**
 * This creates message loads that generate overload conditions for IMAP using
 * our default constants.
 */

define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');

return new LegacyGelamTest('obliterate', function(T) {
  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U', { stockDefaults: true }),
      testAccount = T.actor('TestAccount', 'A', { universe: testUniverse }),
      eSync = T.lazyLogger('sync');

  var N = 1;
  const FILL_SIZE = 60*N;
  testUniverse.do_adjustSyncValues({
    fillSize: FILL_SIZE,
  });

  var testFolder = testAccount.do_createTestFolder(
    'test_torture',
    { count: FILL_SIZE * 20*N, age: { days: 0 }, age_incr: { days: 10 },
      age_incr_every: FILL_SIZE * 5 });
  testAccount.do_viewFolder(
    'syncs', testFolder,
    // bisect case, all nulls
    [{ count: null, full: null, flags: null, deleted: null },
    // a full day (300) will be fetched, but only 15 returned of course
     { count: FILL_SIZE, full: FILL_SIZE * 5, flags: 0, deleted: 0 }],
    { top: true, bottom: false, grow: false },
    {
      expectFunc: function() {
        // This will generate so much write traffic that a purgeExcessMessages
        // job will be scheduled and run after the sync.
        testAccount.expect_runOp('purgeExcessMessages',
                                 { local: true, server: false, save: false });
        testFolder.storageActor.expect('mutexedCall_begin',
                                       { name: 'purgeExcessMessages' });
        testFolder.storageActor.expect('mutexedCall_end',
                                       { name: 'purgeExcessMessages' });
      }
    }).timeoutMS = 5 * 1000;
});

}); // end define

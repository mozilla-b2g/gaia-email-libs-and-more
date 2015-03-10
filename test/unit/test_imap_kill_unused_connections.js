define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var $sync = require('syncbase');

return [
/**
 * Test that we actually kill all outstanding connections after all
 * slices have been closed.
 */
new LegacyGelamTest('kill connections === true', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A', { universe: testUniverse }),
      eSync = T.lazyLogger('sync');

  // create the folder before turning the connection killer on
  var fullSyncFolder = testAccount.do_createTestFolder(
    'test_initial_full_sync',
    { count: 4, age: { days: 0 }, age_incr: { days: 1 } });

  // NB: The stale connection timer settings won't affect these tests,
  // because STALE_CONNECTION_TIMEOUT_MS is set to a very large value.
  testUniverse.do_adjustSyncValues({
    KILL_CONNECTIONS_WHEN_JOBLESS: true
  });

  T.group('full sync, normal connection timeout');

  // note!  do_viewFolder is now smart enough to expect_deadConnection itself.
  // I, asuth, have verified this.  Obviously if you go mucking in this file
  // you should re-check that.  (But note that the following test step
  // should sanity check us too.)
  testAccount.do_viewFolder(
    'syncs', fullSyncFolder,
    { count: 4, full: 4, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: null },
    { syncedToDawnOfTime: true });

  T.action('no connections should remain open', eSync, function() {
    var acct = testUniverse.universe.accounts[0]._receivePiece;
    eSync.expect('conns left',  0);
    eSync.log('conns left', acct._ownedConns.length);
  });

 T.group('cleanup');
}),

/**
 * Test that we leave the connection open if we flipped the flag off.
 */
new LegacyGelamTest('kill connections === false', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A', { universe: testUniverse,
                                                  restored: true }),
      eSync = T.lazyLogger('sync');

  // NB: The stale connection timer settings won't affect these tests,
  // because STALE_CONNECTION_TIMEOUT_MS is set to a very large value.
  testUniverse.do_adjustSyncValues({
    KILL_CONNECTIONS_WHEN_JOBLESS: false
  });

  T.group('full sync, normal connection timeout');
  var fullSyncFolder = testAccount.do_createTestFolder(
    'test_initial_full_sync',
    { count: 4, age: { days: 0 }, age_incr: { days: 1 } });

  testAccount.do_viewFolder(
    'syncs', fullSyncFolder,
    { count: 4, full: 4, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: null },
    { syncedToDawnOfTime: true });

  T.action('one connection should remain open', eSync, function() {
    var acct = testUniverse.universe.accounts[0]._receivePiece;
    eSync.expect('conns left',  1);
    eSync.log('conns left', acct._ownedConns.length);
  });

 T.group('cleanup');
})

];

}); // end define

/**
 * Make sure POP3 pauses to saveAccountState every once in a while.
 **/
define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');

return new LegacyGelamTest('checkpoint sync', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U');
  var testAccount = T.actor('TestAccount', 'A', { universe: testUniverse });
  var eSync = T.lazyLogger('sync');

  var NUM_MSGS = 10;
  var SAVE_EVERY_N = 2;

  testUniverse.do_adjustSyncValues({
    fillSize: NUM_MSGS,
    POP3_SAVE_STATE_EVERY_N_MESSAGES: SAVE_EVERY_N
  });

  // Use the inbox, so that POP3 will actually run its sync logic.
  T.group('full sync');
  var fullSyncFolder = testAccount.do_useExistingFolderWithType('inbox', '');

  // Add NUM_MSGS to the inbox.
  testAccount.do_addMessagesToFolder(fullSyncFolder,
    { count: NUM_MSGS, age: { days: 0, hours: 2 }, age_incr: { days: 1 } });

  // Now, check that we've called saveAccountState the appropriate
  // number of times; based on the constants above, that would be
  // NUM_MSGS / SAVE_EVERY_N, plus the regular saveAccountState at the
  // end of the sync.
  testAccount.do_viewFolder(
    'syncs', fullSyncFolder,
    { count: NUM_MSGS, full: NUM_MSGS, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: null },
    { syncedToDawnOfTime: true, batches: NUM_MSGS / SAVE_EVERY_N });

  T.group('cleanup');
});

}); // end define

/**
 * POP3 should only download a certain number of messages in each
 * sync, treating the rest as overflow.
 **/
define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');

return new LegacyGelamTest('overflow sync', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U');
  var testAccount = T.actor('TestAccount', 'A', { universe: testUniverse });
  var eSync = T.lazyLogger('sync');

  var NUM_MSGS = 10;
  var MAX_MSGS = 2;

  testUniverse.do_adjustSyncValues({
    fillSize: NUM_MSGS,
    POP3_MAX_MESSAGES_PER_SYNC: MAX_MSGS
  });

  // Use the inbox, so that POP3 will actually run its sync logic.
  var inboxFolder = testAccount.do_useExistingFolderWithType('inbox', '');

  // Add NUM_MSGS to the inbox.
  testAccount.do_addMessagesToFolder(inboxFolder,
    { count: NUM_MSGS, age: { days: 0, hours: 2 }, age_incr: { days: 1 } });

  // Check that we have (NUM_MSGS - MAX_MSGS) left as overflow.
  var folderView = testAccount.do_openFolderView(
    'opens', inboxFolder,
    { count: MAX_MSGS, full: MAX_MSGS },
    { top: true, bottom: true, grow: true, newCount: null },
    { expectFunc: function() {
      // for the purposes of this test, the 'overflowMessages' event
      // will happen _after_ other events, so use set matching
      // so that other events can happen first.
      inboxFolder.connActor.useSetMatching();
      inboxFolder.connActor.expect('overflowMessages',
                                   { count: NUM_MSGS - MAX_MSGS });
    }});

  // Then let's do a grow sync. After this, we should have another
  // MAX_MSGS taken directly from the overflow list.
  testAccount.do_growFolderView(folderView,
                                /* dirMagnitude = */ 2,
                                /* userRequestsGrowth = */ true,
                                /* alreadyExists = */ 2,
    { count: 2, full: 2,
      flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: true, newCount: null },
    { expectFunc: function() {
      inboxFolder.connActor.useSetMatching();
      inboxFolder.connActor.expect('overflowMessages',
                                   { count: NUM_MSGS - MAX_MSGS * 2 });
    }});
  // Then set the overflow sync values to cover all the messages,
  // and assert that we've downloaded the entire folder.
  testUniverse.do_adjustSyncValues({
    POP3_MAX_MESSAGES_PER_SYNC: NUM_MSGS
  });

  testAccount.do_growFolderView(folderView,
                                /* dirMagnitude = */ 6,
                                /* userRequestsGrowth = */ true,
                                /* alreadyExists = */ 4,
    { count: 6, full: 6,
      flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: null },
    { syncedToDawnOfTime: true });

  T.group('cleanup');
});

}); // end define

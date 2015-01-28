define(function(require, exports) {

var $tc = require('rdcommon/testcontext');
var $th_main = require('./resources/th_main');
var slog = require('slog');

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_imap_internaldate_search_ambiguity' }, null,
  [$th_main.TESTHELPER], ['app']);

TD.commonCase('no ambiguity with message deletion', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A', { universe: testUniverse });
  var lc = new slog.LogChecker(T, RT, 'logs');

  var staticNow = new Date(2015, 0, 28, 0, 0, 0).valueOf();
  testUniverse.do_timewarpNow(staticNow, 'Jan 28th 0:00');

  testUniverse.do_adjustSyncValues({
    INITIAL_SYNC_DAYS: 10
  });

  var folder = testAccount.do_createTestFolder(
    'test_search_ambiguity',
    { count: 5, age: { days: 5 }, age_incr: { days: 1 }, age_incr_every: 1 });

  var manipView = testAccount.do_openFolderView(
    'opens', folder,
    { count: 5, full: 5, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: null },
    { syncedToDawnOfTime: true });

  T.action('mutate', folder, function() {
    testAccount.deleteMessagesOnServerButNotLocally(manipView, [2, 3]);
  });

  testUniverse.do_adjustSyncValues({
    INITIAL_FILL_SIZE: 1,
    INITIAL_SYNC_DAYS: 1,
    INITIAL_SYNC_GROWTH_DAYS: 1,
    TIME_SCALE_FACTOR_ON_NO_MESSAGES: 1,
    SYNC_WHOLE_FOLDER_AT_N_MESSAGES: 1000
  });

  testAccount.do_shrinkFolderView(
    manipView, /* low */ 0, /* high */ 0, /* total */ 1,
    { top: true, bottom: false, grow: false });

  function logUid(name, uid) {
    lc.mustLog(name, function(x) { return x.uid === uid; } );
  }
  function growSliceAndWait(growNumber) {
    lc.mustLog('done-complete');
    manipView.slice.oncomplete = function() { slog.log('done-complete'); }
    manipView.slice.requestGrowth(growNumber, true);
  }

  // Server UIDs: [1 2] (missing #3)
  // DB Lookup:   [1 2 3]
  T.action('sync/grow #1', folder, function() {
    logUid('imap:updated-uid', 1);
    logUid('imap:updated-uid', 2);
    logUid('imap:ambiguously-missing-uid', 3);
    growSliceAndWait(1);
  });

  // Server UIDs: [1 2] (missing #3 and #4)
  // DB Lookup:   [1 2 3 4]
  T.action('sync/grow #2', folder, function() {
    logUid('imap:ambiguously-missing-uid', 1);
    logUid('imap:updated-uid', 2);
    logUid('imap:ambiguously-missing-uid', 3);
    logUid('imap:ambiguously-missing-uid', 4);
    growSliceAndWait(1);
  });

  // Server UIDs: [] (nothing returned)
  // DB Lookup:     [2 3 4 5], 3 is unambiguously deleted
  T.action('sync/grow #3', folder, function() {
    logUid('imap:ambiguously-missing-uid', 2);
    logUid('imap:unambiguously-deleted-uid', 3);
    logUid('imap:ambiguously-missing-uid', 4);
    logUid('imap:ambiguously-missing-uid', 5);
    growSliceAndWait(1);
  });

  // Server UIDs:         [5]
  // DB Lookup:         [4 5], 4 is unambiguously deleted
  T.action('sync/grow #4', folder, function() {
    logUid('imap:unambiguously-deleted-uid', 4);
    logUid('imap:updated-uid', 5);
    growSliceAndWait(1);
  });

  testAccount.do_closeFolderView(manipView);
});


});

define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var $date = require('date');

/**
 * Test ambiguity logic.  Core cases we want to check:
 * - Opening a slice where the oldest message is deleted on the server.  We want
 *   to ensure that we don't just mark the message ambiguous, but we actually
 *   delete it.
 * - Test that growing a slice to a message that is deleted and would
 *   potentially have been ambiguous is fully deleted.
 * - Test that growing to a deleted message again after the prior case's
 *   deletion still works.  (Deletion impacts the bounds of the slice so we
 *   want to make sure nothing weird/dumb happens.  Note that arguably the
 *   previous case was also testing this, but that was a transition from the
 *   refresh logic, so it was more testing the refresh logic than grow.)
 * - Test that growing to a not-deleted message again after that prior case.
 * - Test growing to a deleted after that not deleted one.
 * - Test growing to a not-deleted one that is the last message in the folder
 *   and so triggers a dawn-of-time sync.
 * - (Tricky!) Ensure that in the complicated situation where we have marked a
 *   message as ambiguous on its old side, that we don't mark it deleted when
 *   we're also seeing it be ambiguous on new side *but not in its core day*.
 *   Prior to this case, we would naively do a set union which would make it
 *   seem like we had checked that core day when we, in fact, had not.
 *
 * For the slice growing logic to window off any message, we need (at least) 2
 * most recent messages, then we can do our deletion and such.
 *
 * We plan to start out with: [1 2 3 4 5 6 7].
 * And end up with (* = del): [1 2 * * 5 * 7].
 *
 * NOTE: This is an exciting adventure in the new style of test writing.  There
 * are some comments in here that explain what's going on as of the time of this
 * test like the date-ranges that are not actually checked.  We don't expect
 * them to regress, but feel free to suspect them if this stuff breaks.
 */
return new LegacyGelamTest('no ambiguity with message deletion',
                           function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A', { universe: testUniverse });

  var eFolderConn = T.actor('ImapFolderConn');

  var staticNow = Date.UTC(2015, 0, 28, 12, 0, 0);
  testUniverse.do_timewarpNow(staticNow, 'Jan 28th 12:00 UTC');

  testUniverse.do_adjustSyncValues({
    INITIAL_SYNC_DAYS: 10
  });

  // In order for slice growing to do a moving window, we need to have at least
  // 2 messages in the slice.
  var folder = testAccount.do_createTestFolder(
    'test_search_ambiguity',
    { count: 7, age: { days: 1 }, age_incr: { days: 1 }, age_incr_every: 1 });

  var manipView = testAccount.do_openFolderView(
    'opens and initial syncs', folder,
    { count: 7, full: 7, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: null },
    { syncedToDawnOfTime: true });

  T.action('mutate', folder, function() {
    testAccount.deleteMessagesOnServerButNotLocally(manipView, [2, 3, 5]);
  });

  testAccount.do_closeFolderView(manipView);

  testUniverse.do_adjustSyncValues({
    // (see the checkView opening comments below for the use of 2)
    INITIAL_FILL_SIZE: 3,
    INITIAL_SYNC_DAYS: 1,
    INITIAL_SYNC_GROWTH_DAYS: 1,
    TIME_SCALE_FACTOR_ON_NO_MESSAGES: 1,
    SYNC_WHOLE_FOLDER_AT_N_MESSAGES: 1000,
    // let the the sync accuracy range be used and thereby the grow requests
    // perform windowing.  We do need to do jump into the future sufficiently
    // to cause us to cross both of these thresholds.  (We choose a large
    //  interval here to ensure that no matter how slow our test runs,
    // we won't accidentally have these expire.  But not so large that it
    // impacts the grow logic's use of the constants!)
    INITIAL_REFRESH_THRESH_MS: $date.HOUR_MILLIS,
    GROW_REFRESH_THRESH_MS: $date.HOUR_MILLIS,
  });

  staticNow = Date.UTC(2015, 0, 29, 12, 0, 0);
  testUniverse.do_timewarpNow(staticNow,
                              'advance a day for refresh thresholds');

  function logUid(name, uid) {
    eFolderConn.expect(name, function(x) { return x.uid === uid; } );
  }
  function growSliceAndWait(growNumber) {
    eFolderConn.expect('done-complete');
    checkView.slice.oncomplete = () => eFolderConn.log('done-complete');
    checkView.slice.requestGrowth(growNumber, true);
  }

 // January date-wise, our mapping is:
 // UIDs: [ 1  2  3  4  5  6  7]
 // Date: [27 26 25 24 23 22 21]

  T.group('sliceOpenMostRecent refresh sync');
  // Because INITIAL_FILL_SIZE is 3, the slice open returns 3 messages.  But
  // in order to unambiguously be able to detect deletion of those messages,
  // the server query will be extended by a day, covering UID 3.  This in
  // turn means the DB query will grow one further, including UID 4.
  var checkView = testAccount.do_openFolderView(
    'sync/refresh #1', folder,
    { count: 2, full: 0, flags: 2, deleted: 1 },
    { top: true, bottom: false, grow: false, newCount: 0 },
    {
      syncedToDawnOfTime: true,
      // Slice  UIDs: [1 2 3]
      // Server UIDs: [1 2    ]   SINCE 24-Jan (UID 4)
      // DB Lookup:   [1 2 3 4 5]
      // DB After:    [1 2   4 5]
      expectFunc: function() {
        logUid('updated-uid', 1);
        logUid('updated-uid', 2);
        logUid('unambiguously-deleted-uid', 3);
        logUid('ambiguously-missing-uid', 4);
        logUid('ambiguously-missing-uid', 5);
      }
    });

  T.group('grow slice refreshes');

  // Set the fill size back to 1 since the value 1 actually asks for the
  // default (INITIAL_FILL_SIZE), so we need to set the default to 1.
  testUniverse.do_adjustSyncValues({
    INITIAL_FILL_SIZE: 1,
  });

  // Slice UIDs:  [1 2   4]
  // Server UIDs:         [5]   SINCE 23-Jan (UID 5) BEFORE 24-Jan (UID 4)
  // DB Lookup:         [4 5 6]
  // DB After:          [  5 6]
  T.action('sync/grow #2', folder, function() {
    logUid('unambiguously-deleted-uid', 4);
    logUid('updated-uid', 5);
    logUid('ambiguously-missing-uid', 6);
    growSliceAndWait(1);
  });

  // Slice UIDs:  [1 2     5]
  // Server UIDs:           [ ] SINCE 22-Jan (UID 6) BEFORE 23-Jan (UID 5)
  // DB Lookup:           [5 6 7]
  // DB After:            [5 6 7]
  T.action('sync/grow #3', folder, function() {
    logUid('ambiguously-missing-uid', 5);
    logUid('ambiguously-missing-uid', 6);
    logUid('ambiguously-missing-uid', 7);
    growSliceAndWait(1);
  });

  // Slice UIDs:  [1 2     5 6]
  // Server UIDs:             [7] SINCE 21-Jan (UID 7) BEFORE 22-Jan (UID 6)
  // DB Lookup:             [6 7]
  // DB After:              [  7]
  T.action('sync/grow #4', folder, function() {
    logUid('unambiguously-deleted-uid', 6);
    logUid('updated-uid', 7);
    growSliceAndWait(1);
  });

  // Slice UIDs:  [1 2     5   7]
  // Server UIDs:                [] SINCE 1990 BEFORE 21-Jan (UID 7)
  // DB Lookup:               [7]
  // DB After:                [7]
  //
  T.action('sync/grow #5', folder, function() {
    logUid('ambiguously-missing-uid', 7);
    growSliceAndWait(1);
  });

  T.group('tricky double-sided ambiguity');
  // We could do this by shrinking stuff off, but given the current front-end
  // and how I reproduced this manually, it's more realistic to close and open
  // the view with the used headers so we're right up against the ambiguous new
  // side of 7.

  testAccount.do_closeFolderView(checkView);

  // jump time forward so we will trigger a refresh
  staticNow += 2 * $date.HOUR_MILLIS;
  testUniverse.do_timewarpNow(staticNow,
                              'advance a day for refresh thresholds');

  // By asking through UID 5, the search range will cover UID 6 and be on the
  // "new" ambiguous side of 7.
  //
  // Slice UIDs:  [1 2     5]
  // Server UIDs: [           ]    SINCE 22-Jan (UID 6)
  // DB Lookup:               [7]
  // DB After:                [7]
  testUniverse.do_adjustSyncValues({
    INITIAL_FILL_SIZE: 3
  });
  T.action('fix-up knownMessages', function() {
    // Because we bypassed the th_main infrastructure above but use
    // do_openFolderView, it freaks out if knownMessages is out-of-date, so just
    // manually update it.
    folder.knownMessages = folder.serverMessages;
    // (Note that the logUid expectations are generally sufficient, it's just
    // there was no open helper and this was pretty easy, and if we need to mix
    // a bisect case into thise later, we really do need the do_openFolderView
    // helper then.)
  });
  var trickyView = testAccount.do_openFolderView(
    'sync/refresh #1', folder,
    { count: 3, full: 0, flags: 3, deleted: 0 },
    { top: true, bottom: false, grow: false, newCount: 0 },
    {
      syncedToDawnOfTime: true,
      expectFunc: function() {
        logUid('updated-uid', 1);
        logUid('updated-uid', 2);
        logUid('updated-uid', 5);
        logUid('ambiguously-missing-uid', 7);
      }
    });

  T.group('cleanup');
  testAccount.do_closeFolderView(trickyView);
});

});

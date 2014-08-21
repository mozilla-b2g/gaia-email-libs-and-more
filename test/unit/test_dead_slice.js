define(['rdcommon/testcontext', './resources/th_main',
        'mailslice', 'exports'],
       function($tc, $th_main, $mailslice, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_dead_slice' }, null, [$th_main.TESTHELPER], ['app']);

// Ensure that if we end up trying to refresh a dead slice, we bail out.
TD.commonCase('refresh a dead slice', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse }),
      eSync = T.lazyLogger('sync');

  T.group('populate folder');
  var syncFolder = testAccount.do_createTestFolder(
    'test_sync_empty_slice',
    { count: 15, age: { days: 0 }, age_incr: { days: 1 } });

  var testView = testAccount.do_openFolderView(
    'syncs', syncFolder,
    null, null,
    { syncedToDawnOfTime: true });

  T.action('kill slice, then refresh', eSync, function() {
    var proxy = testAccount.getSliceBridgeProxyForView(testView);
    var storage =
          testAccount.universe.getFolderStorageForFolderId(syncFolder.id);
    var slice = new $mailslice.MailSlice(proxy, storage);

    // Kill the slice first.
    slice.die();

    // We expect the forthcoming sliceOpenMostRecent() call to do nothing;
    // i.e. it should definitely not mess with the accuracy ranges, as it
    // did before <https://bugzil.la/941991>.
    eSync.expect_namedValue('accuracyRangeStart',
                            storage._accuracyRanges[0].startTS);

    // Now, open the dead slice.
    storage.sliceOpenMostRecent(slice, true);

    // Hook into the slice's status updates, since sliceOpenMostRecent
    // doesn't offer a callback. We just want to know what happens
    // after sync finishes.
    slice.setStatus = function(status) {
      eSync.namedValue('accuracyRangeStart',
                       storage._accuracyRanges[0].startTS);
    };
  });

  T.group('cleanup');
  testAccount.do_closeFolderView(testView);
});

}); // end define

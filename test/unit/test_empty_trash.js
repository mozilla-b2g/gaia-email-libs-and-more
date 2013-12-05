/**
 * Test the empty trash mechanism for POP3; someday IMAP and ActiveSync.
 *
 * Note that this does not test all the online/offline/undo/redo stuff that
 * test_mutation.js covers for deletion/undeletion.  This is just about emptying
 * the contents of the trash.  Although we will need to make things much more
 * complicated when we do the server component stuff in the future.
 */

define(['rdcommon/testcontext', './resources/th_main',
        'activesync/codepages/AirSync', 'exports'],
       function($tc, $th_main, $airsync, exports) {
const FilterType = $airsync.Enums.FilterType;

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_empty_trash' }, null,
  [$th_main.TESTHELPER], ['app']);

/**
 * Verify that emptying the trash kills the messages and that they stay dead.
 * - Have a folder with some messages
 * - delete those messages
 * - see them show up in the trash folder
 * - empty the trash folder
 * - see the slice for the trash folder updated to have nothing in it
 * - close the slice
 * Paranoia 1: make sure the account mapping is right
 * - (re)open the folder
 * - see there are still no messages in that there folder
 * - close the slice
 * Paranoia 2: make sure the changes got saved to disk
 * - uncleanly close the universe down
 * - bring the universe back up
 * - open the slice
 * - make sure the folder is still empty.
 */
TD.commonCase('Empty trash', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var TU1 = T.actor('testUniverse', 'U1'),
      TA1 = T.actor('testAccount', 'A1',
                    { universe: TU1 }),
      eCheck = T.lazyLogger('check');

  T.group('have messages');
  // 3 is enough to test things, probably.
  var numMessages = 3;
  var sourceFolder = TA1.do_createTestFolder(
    'test_empty_trash_source',
    { count: numMessages, age_incr: { days: 1 } });

  var sourceView = TA1.do_openFolderView(
    'sourceView', sourceFolder,
    { count: numMessages, full: numMessages, flags: 0, changed: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.group('delete the messages, see them in the trash');
  // XXX for real server tests in the future, we will probably actually want to
  // nuke and re-create the trash folder since we have assumptions below about
  // what's in that folder
  var trashFolder1 = TA1.do_useExistingFolderWithType('trash', '');
  var trashView1 = TA1.do_openFolderView(
    'opens', trashFolder1,
    { count: 0, full: 0, flags: 0, changed: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.check(eCheck, 'trash folder type invariants', function() {
    eCheck.expect_namedValue('folder type', 'trash');
    eCheck.expect_namedValue('folder account type', 'pop3+smtp');

    eCheck.namedValue('folder type', trashFolder1.mailFolder.type);
    eCheck.namedValue('folder account type',
                      trashFolder1.mailFolder.accountType);
  });

  T.action('delete the messages, see them in the trash', function() {
    var headers = sourceView.slice.items;
    TA1.expect_runOp(
      'delete',
      { local: true, server: true, save: true });

    TA1.expect_headerChanges(
      sourceView,
      { additions: [], changes: [], deletions: headers },
      null, /* done after all deleted */ numMessages);
    TA1.expect_headerChanges(
      trashView1,
      { additions: headers, changes: [], deletions: [] },
      null, /* done after all deleted */ numMessages);

    TU1.MailAPI.deleteMessages(headers);
  });

  TA1.do_closeFolderView(sourceView);

  T.group('empty the trash, see the messages disappear');
  T.action(TA1.eFolderAccount, 'empties the trash folder,',
           'the messages disappear', function() {
    var headers = trashView1.slice.items;

    TA1.expect_headerChanges(
      trashView1,
      { additions: [], changes: [], deletions: headers },
      null, /* done after all deleted */ numMessages);

    TA1.expect_runOp(
      'emptyFolder',
      { local: true, server: false, save: false,
        localExpectFunc: function() {
          TA1._expect_recreateFolder(trashFolder1);
        }
      });

    // the recreateFolder will call sliceOpenMostRecent, so we get more sync
    // mutex notifications.
    trashFolder1.storageActor.expect_mutexedCall_begin('sync');
    trashFolder1.storageActor.expect_syncedToDawnOfTime();
    trashFolder1.storageActor.expect_mutexedCall_end('sync');
    TA1.eFolderAccount.expect_saveAccountState('checkpointSync');

    trashFolder1.mailFolder.emptyFolder();
  });

  T.group('see the messages still disappeared if we reopen the folder');
  TA1.do_closeFolderView(trashView1);

  TA1.do_viewFolder(
    'opens', trashFolder1,
    { count: 0, full: 0, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.group('shutdown the universe in an unclean fashion (crash)');
  // it's unclean if we don't call do_saveState() first.
  TU1.do_shutdown();

  T.group('bring the universe back'); // it was a pretty good universe...
  var TU2 = T.actor('testUniverse', 'U2', { old: TU1 }),
      TA2 = T.actor('testAccount', 'A2',
                    { universe: TU2, restored: true });
  var trashFolder2 = TA2.do_useExistingFolderWithType('trash', '');

  T.group('make sure the messages are still gone'); // zombies suck.
  TA2.do_viewFolder(
    'opens', trashFolder2,
    { count: 0, full: 0, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.group('cleanup');
});

}); // end define

/**
 * Account logic that currently needs to be its own file because IndexedDB
 * db reuse makes this test unhappy.
 **/

define(['rdcommon/testcontext', './resources/th_main',
        'activesync/codepages', 'exports'],
       function($tc, $th_main, $ascp, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_account_logic' }, null,
  [$th_main.TESTHELPER], ['app']);

/**
 * Test that we can add and remove accounts and that the view-slices properly
 * update and that database rows get nuked appropriately.
 *
 * For simplicity, we currently create duplicate accounts.  This obviously will
 * not work once we prevent creating duplicate accounts.
 */
TD.commonCase('account creation/deletion', function(T, RT) {
  T.group('create universe, first account');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U',
                             { name: 'A' }),
      testAccountA = T.actor('testAccount', 'A',
                             { universe: testUniverse }),
      eSliceCheck = T.lazyLogger('sliceCheck');
  var folderPointAB = null, folderPointBC = null, folderPointC = null;
  T.action('snapshot number of folders', function() {
    folderPointAB = gAllFoldersSlice.items.length;
  });


  T.group('create second account');
  var testAccountB = T.actor('testAccount', 'B',
                             { universe: testUniverse, name: 'B',
                               forceCreate: true });
  T.check(eSliceCheck, 'account and folders listed', function() {
    // the account should be after the known account
    eSliceCheck.expect_namedValue('accounts[1].id', testAccountB.accountId);
    eSliceCheck.namedValue('accounts[1].id', gAllAccountsSlice.items[1].id);

    // There should be some folders (don't know how many; it's probably a
    // realish account), located after all previously known folders.

    eSliceCheck.expect_event('folders present');
    folderPointBC = gAllFoldersSlice.items.length;
    var bFoldersObserved = 0;
    if (gAllFoldersSlice.items[folderPointAB].type !== 'account')
      throw new Error('Account folder not created!');

    for (var i = folderPointAB; i < gAllFoldersSlice.items.length; i++) {
      var folder = gAllFoldersSlice.items[i];
      if (folder.id[0] === testAccountB.accountId)
        bFoldersObserved++;
      else
        break;
    }
    if (bFoldersObserved !== folderPointBC - folderPointAB)
      throw new Error("Invariant problemo; did not scan all folders; " +
                      bFoldersObserved + ' observed, ' +
                      (folderPointBC - folderPointAB) + ' expected');
    eSliceCheck.event('folders present');
  });

  T.group('create third account');
  var testAccountC = T.actor('testAccount', 'C',
                             { universe: testUniverse, forceCreate: true });
  T.check(eSliceCheck, 'account and folders listed', function() {
    // the account should be after the known account
    eSliceCheck.expect_namedValue('accounts[1].id', testAccountB.accountId);
    eSliceCheck.namedValue('accounts[1].id', gAllAccountsSlice.items[1].id);

    // There should be some folders (don't know how many; it's probably a
    // realish account), located after all previously known folders.

    eSliceCheck.expect_event('folders present');
    folderPointC = gAllFoldersSlice.items.length;
    var cFoldersObserved = 0;
    if (gAllFoldersSlice.items[folderPointBC].type !== 'account')
      throw new Error('Account folder not created!');
    for (var i = folderPointBC; i < gAllFoldersSlice.items.length; i++) {
      var folder = gAllFoldersSlice.items[i];
      if (folder.id[0] === testAccountC.accountId)
        cFoldersObserved++;
      else
        break;
    }
    if (cFoldersObserved !== folderPointC - folderPointBC)
      throw new Error("Invariant problemo; did not scan all folders; " +
                      bFoldersObserved + ' observed, ' +
                      (folderPointC - folderPointBC) + ' expected');
    eSliceCheck.event('folders present');
  });

  T.group('delete second (middle) account');
  T.action('delete account', testAccountB, 'perform', eSliceCheck,
           testAccountB.eOpAccount, function() {
    // note: we used to expect_deadConnection here because our
    // EventEmitter.removeAllListeners was broken, so we still got close events
    // after we no longer wanted them.

    eSliceCheck.expect_namedValue('remaining account', testAccountA.accountId);
    eSliceCheck.expect_namedValue('remaining account', testAccountC.accountId);

    var expectedFolders = folderPointC - (folderPointBC - folderPointAB);
    eSliceCheck.expect_namedValue('num folders', expectedFolders);
    eSliceCheck.expect_namedValue('folder[AB-1].account',
                                  testAccountA.accountId);
    eSliceCheck.expect_namedValue('folder[AB].account',
                                  testAccountC.accountId);
    testAccountB.eOpAccount.expect_accountDeleted('saveAccountState');

    // this does not have a callback, so use a ping to wait...
    gAllAccountsSlice.items[1].deleteAccount();
    MailAPI.ping(function() {
      var i;
      for (i = 0; i < gAllAccountsSlice.items.length; i++) {
        eSliceCheck.namedValue('remaining account',
                               gAllAccountsSlice.items[i].id);
      }

      eSliceCheck.namedValue('num folders', gAllFoldersSlice.items.length);
      eSliceCheck.namedValue(
        'folder[AB-1].account',
        gAllFoldersSlice.items[folderPointAB-1].id[0]);
      eSliceCheck.namedValue(
        'folder[AB].account',
        gAllFoldersSlice.items[folderPointAB].id[0]);

      testAccountB.account.saveAccountState();
    });
  });

  T.action(testUniverse, 'check database does not contain', function() {
    testUniverse.help_checkDatabaseDoesNotContain([
      { table: 'config', prefix: 'accountDef:' + testAccountB.accountId },
      { table: 'folderInfo', prefix: testAccountB.accountId },
      { table: 'headerBlocks', prefix: testAccountB.accountId + '/' },
      { table: 'bodyBlocks', prefix: testAccountB.accountId + '/' },
    ]);
  });

  T.group('cleanup');
});

TD.commonCase('create a second (unique) account', function(T, RT) {
  var TEST_PARAMS = RT.envOptions;
  // XXX: we can only create multiple accounts on ActiveSync for now!
  if (TEST_PARAMS.variant === 'activesync:fake') {
    var testUniverse = T.actor('testUniverse', 'U'),
        // at this point 2 duplicate accounts exist...
        testAccountA = T.actor('testAccount', 'A',
                              { universe: testUniverse, restored: true }),
        testAccountB = T.actor('testAccount', 'B',
                              { universe: testUniverse, restored: true }),
        testAccountC = T.actor('testAccount', 'C',
                              { universe: testUniverse,
                                emailAddress: 'test2@fakeashost' }),
        eSync = T.lazyLogger('sync');
  }
});

TD.commonCase('try to create a duplicate account', function(T, RT) {
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U'),
      eSync = T.lazyLogger('sync');
  T.action('create account', testUniverse, eSync, function(T) {
    eSync.expect_namedValue('account-creation-error', 'user-account-exists');
    testUniverse.MailAPI.tryToCreateAccount(
      {
        displayName: TEST_PARAMS.name,
        emailAddress: TEST_PARAMS.emailAddress,
        password: TEST_PARAMS.password,
        accountName: null
      },
      null,
      function accountMaybeCreated(error) {
        eSync.namedValue('account-creation-error', error);
      }
    );
  });
});


}); // end define

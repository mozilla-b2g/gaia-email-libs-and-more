/**
 * Account logic that currently needs to be its own file because IndexedDB
 * db reuse makes this test unhappy.
 **/
define(function(require) {

var $ascp = require('activesync/codepages');
var LegacyGelamTest = require('./resources/legacy_gelamtest');

/**
 * Test that we can add and remove accounts and that the view-slices properly
 * update and that database rows get nuked appropriately.
 *
 * For simplicity, we currently create duplicate accounts.  This obviously will
 * not work once we prevent creating duplicate accounts.
 *
 * We do a few minor checks here that could potentially be separate tests but
 * they're so easy/fast to do here:
 * - ActiveSync: Make sure each account uses a different device id.
 * - ActiveSync: Make sure we're using those device id's to talk to the server.
 */
return [

new LegacyGelamTest('account creation/deletion', function(T, RT) {
  T.group('create universe, first account');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('TestUniverse', 'U',
                             { name: 'A' }),
      testAccountA = T.actor('TestAccount', 'A',
                             { universe: testUniverse }),
      eSliceCheck = T.lazyLogger('sliceCheck'),
      eLazyCheck = T.lazyLogger('check');
  var folderPointAB = null, folderPointBC = null, folderPointC = null;
  T.action('snapshot number of folders', function() {
    folderPointAB = gAllFoldersSlice.items.length;
  });

  if (TEST_PARAMS.type === 'activesync') {
    T.check(eLazyCheck, 'uses device id with server', function() {
      var idA = testAccountA.account.accountDef.connInfo.deviceId;
      eLazyCheck.expect('server observed device ids',  [idA]);
      eLazyCheck.log(
        'server observed device ids',
        testAccountA.testServer.getObservedDeviceIds({ clear: true }));
    });
  }


  T.group('create second account');
  var testAccountB = T.actor('TestAccount', 'B',
                             { universe: testUniverse, name: 'B',
                               forceCreate: true });
  T.check(eSliceCheck, 'account and folders listed', function() {
    // the account should be after the known account
    eSliceCheck.expect('accounts[1].id',  testAccountB.accountId);
    eSliceCheck.log('accounts[1].id', gAllAccountsSlice.items[1].id);

    // There should be some folders (don't know how many; it's probably a
    // realish account), located after all previously known folders.

    eSliceCheck.expect('folders present');
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
    eSliceCheck.log('folders present');
  });

  if (TEST_PARAMS.type === 'activesync') {
    T.check(eLazyCheck, 'uses device id with server', function() {
      var idB = testAccountB.account.accountDef.connInfo.deviceId;
      eLazyCheck.expect('server observed device ids',  [idB]);
      eLazyCheck.log(
        'server observed device ids',
        testAccountB.testServer.getObservedDeviceIds({ clear: true }));
    });

    T.check(eLazyCheck, 'different device ids', function() {
      eLazyCheck.expect('device ids',  'different');
      var idA = testAccountA.account.accountDef.connInfo.deviceId;
      var idB = testAccountB.account.accountDef.connInfo.deviceId;
      eLazyCheck.log(
        'device ids', (idA === idB) ? 'same' : 'different',
        { idA: idA, idB: idB });
    });
  }

  T.group('create third account');
  var testAccountC = T.actor('TestAccount', 'C',
                             { universe: testUniverse, forceCreate: true });
  T.check(eSliceCheck, 'account and folders listed', function() {
    // the account should be after the known account
    eSliceCheck.expect('accounts[1].id',  testAccountB.accountId);
    eSliceCheck.log('accounts[1].id', gAllAccountsSlice.items[1].id);

    // There should be some folders (don't know how many; it's probably a
    // realish account), located after all previously known folders.

    eSliceCheck.expect('folder type at insertion',  'account');
    eSliceCheck.expect('folders present');
    folderPointC = gAllFoldersSlice.items.length;
    var cFoldersObserved = 0;
    eSliceCheck.log('folder type at insertion', 'account',
                            gAllFoldersSlice.items.concat());
    for (var i = folderPointBC; i < gAllFoldersSlice.items.length; i++) {
      var folder = gAllFoldersSlice.items[i];
      if (folder.id[0] === testAccountC.accountId)
        cFoldersObserved++;
      else
        break;
    }
    if (cFoldersObserved !== folderPointC - folderPointBC)
      throw new Error("Invariant problemo; did not scan all folders; " +
                      cFoldersObserved + ' observed, ' +
                      (folderPointC - folderPointBC) + ' expected');
    eSliceCheck.log('folders present');
  });

  T.group('delete second (middle) account');
  T.action('delete account', testAccountB, 'perform', eSliceCheck,
           testAccountB.eOpAccount, function() {
    // note: we used to expect_deadConnection here because our
    // EventEmitter.removeAllListeners was broken, so we still got close events
    // after we no longer wanted them.

    eSliceCheck.expect('remaining account',  testAccountA.accountId);
    eSliceCheck.expect('remaining account',  testAccountC.accountId);

    var expectedFolders = folderPointC - (folderPointBC - folderPointAB);
    eSliceCheck.expect('num folders',  expectedFolders);
    eSliceCheck.expect('folder[AB-1].account', testAccountA.accountId);
    eSliceCheck.expect('folder[AB].account', testAccountC.accountId);

    // IMAP accounts still have one connection open.
    if (TEST_PARAMS.type === 'imap') {
      testAccountB.eOpAccount.expect('deadConnection');
    }
    testAccountB.eOpAccount.expect('accountDeleted',
                                   { reason: 'saveAccountState' });

    // this does not have a callback, so use a ping to wait...
    // ... but the ping fires too early, so wait for onremove,
    // and _then_ ping (because onremove is fired before the
    // item is actually spliced from gAllAccountsSlice).
    gAllAccountsSlice.items[1].deleteAccount();
    gAllAccountsSlice.onremove = function() {
      testUniverse.MailAPI.ping(function() {
        gAllAccountsSlice.onremove = null;
        var i;
        for (i = 0; i < gAllAccountsSlice.items.length; i++) {
          eSliceCheck.log('remaining account',
                                 gAllAccountsSlice.items[i].id);
        }

        eSliceCheck.log('num folders', gAllFoldersSlice.items.length);
        eSliceCheck.log(
          'folder[AB-1].account',
          gAllFoldersSlice.items[folderPointAB-1].id[0]);
        eSliceCheck.log(
          'folder[AB].account',
          gAllFoldersSlice.items[folderPointAB].id[0]);

        testAccountB.account.saveAccountState();
      });
    };
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
}),

new LegacyGelamTest('create a second (unique) account', function(T, RT) {
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('TestUniverse', 'U'),
      // at this point 2 duplicate accounts exist...
      testAccountA = T.actor('TestAccount', 'A',
                            { universe: testUniverse, restored: true }),
      testAccountB = T.actor('TestAccount', 'B',
                            { universe: testUniverse, restored: true }),
      // because of server reuse and wanting this to be a new account,
      // it needs to be a letter other than 'C'
      testAccountC = T.actor(
        'TestAccount', 'D',
        {
          universe: testUniverse,
          emailAddress: 'test2@' + TEST_PARAMS.emailDomain
        }),
      eSync = T.lazyLogger('sync');
}),

new LegacyGelamTest('try to create a duplicate account', function(T, RT) {
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('TestUniverse', 'U', { restored: true }),
      eSync = T.lazyLogger('sync');
  T.action('create account', testUniverse, eSync, function(T) {
    eSync.expect('account-creation-error',  'user-account-exists');
    testUniverse.MailAPI.tryToCreateAccount(
      {
        displayName: TEST_PARAMS.name,
        emailAddress: TEST_PARAMS.emailAddress,
        password: TEST_PARAMS.password,
        accountName: null
      },
      null,
      function accountMaybeCreated(error) {
        eSync.log('account-creation-error', error);
      }
    );
  });
})

];


}); // end define

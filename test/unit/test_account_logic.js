/**
 * Account logic that currently needs to be its own file because IndexedDB
 * db reuse makes this test unhappy.
 **/

define(['rdcommon/testcontext', './resources/th_main',
        './resources/th_activesync_server',
        'activesync/codepages', 'exports'],
       function($tc, $th_imap, $th_as_srv, $ascp, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_account_logic' }, null,
  [$th_imap.TESTHELPER, $th_as_srv.TESTHELPER], ['app']);

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
  if (TEST_PARAMS.type === 'activesync') {
    var testUniverse = T.actor('testUniverse', 'U'),
        testAccountA = T.actor('testAccount', 'A',
                              { universe: testUniverse, restored: true }),
        testAccountB = T.actor('testAccount', 'B',
                              { universe: testUniverse,
                                emailAddress: 'test2@aslocalhost' }),
        eSync = T.lazyLogger('sync');
  }
});

TD.commonCase('try to create a duplicate account', function(T, RT) {
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U'),
      eSync = T.lazyLogger('sync');
  T.action('create account', testUniverse, eSync, function(T) {
    eSync.expect_namedValue('account-creation-error', 'user-account-exists');
    // XXX: This is a bit of a hack to get the right address for the ActiveSync
    // fake server.
    var address = TEST_PARAMS.type === 'imap' ? TEST_PARAMS.emailAddress :
                 'test@aslocalhost';
    testUniverse.MailAPI.tryToCreateAccount(
      {
        displayName: TEST_PARAMS.name,
        emailAddress: address,
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

/**
 * Make sure we don't get duplicate folders from running syncFolderList a
 * second time.  Our account list should be up-to-date at this time, so
 * running it a second time should not result in a change in the number of
 * folders.  We also want to rule out the existing folders being removed and
 * then replaced with effectively identical ones, so we listen for splice
 * notifications.
 */
TD.commonCase('syncFolderList is idempotent', function(T) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eSync = T.lazyLogger('sync');

  T.group('syncFolderList and check');
  var numFolders, numAdds = 0, numDeletes = 0;
  T.action('run syncFolderList', eSync, function(T) {
    numFolders = testUniverse.allFoldersSlice.items.length;
    testUniverse.allFoldersSlice.onsplice = function(index, delCount,
                                                     addedItems) {
      numAdds += addedItems.length;
      numDeletes += delCount;
    };

    testAccount.expect_runOp('syncFolderList',
                             { local: false, server: true, conn: true });
    eSync.expect_event('roundtripped');
    testUniverse.universe.syncFolderList(testAccount.account, function() {
      testUniverse.MailAPI.ping(function() {
        eSync.event('roundtripped');
      });
    });
  });
  T.check('check folder list', eSync, function(T) {
    eSync.expect_namedValue('num folders', numFolders);
    eSync.expect_namedValue('num added', numAdds);
    eSync.expect_namedValue('num deleted', numDeletes);
    eSync.namedValue('num folders', testUniverse.allFoldersSlice.items.length);
    eSync.namedValue('num added', numAdds);
    eSync.namedValue('num deleted', numDeletes);
  });

  T.group('cleanup');
});

TD.commonCase('syncFolderList created localdrafts folder', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eCheck = T.lazyLogger('check');

  T.group('check for localdrafts folder');
  T.check(eCheck, 'localdrafts folder', function() {
    eCheck.expect_namedValue('has localdrafts folder?', true);
    var sent = testUniverse.allFoldersSlice.getFirstFolderWithType('sent');
    // the path should place it next to the existing drafts folder, but we
    // frequently don't have that folder, so use sent, which is our fallback
    // anyways and should be consistently located
    eCheck.expect_namedValue('path',
                             sent.path.replace(/sent.*/i, 'localdrafts'));

    var localDrafts = testUniverse.allFoldersSlice
                        .getFirstFolderWithType('localdrafts');
    eCheck.namedValue('has localdrafts folder?', !!localDrafts);
    eCheck.namedValue('path', localDrafts.path);
  });
});


TD.commonCase('syncFolderList obeys hierarchy', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U'),
      testServer = null,
      eSync = T.lazyLogger('sync');

  if (TEST_PARAMS.type === 'activesync') {
    testServer = T.actor('testActiveSyncServer', 'S',
                         { universe: testUniverse });
    T.action('create test folders', function() {
      const folderType = $ascp.FolderHierarchy.Enums.Type;
      var inbox = testServer.getFirstFolderWithType('inbox'),
          sent  = testServer.getFirstFolderWithType('sent'),
          trash = testServer.getFirstFolderWithType('trash');

      var subinbox = testServer.addFolder(
        'Subinbox', folderType.Mail, inbox.folderId);
      testServer.addFolder(
        'Subsubinbox', folderType.Inbox, subinbox.folderId);

      var subsent = testServer.addFolder(
        'Subsent', folderType.Mail, sent.folderId);
      testServer.addFolder(
        'Subsubsent', folderType.Inbox, subsent.folderId);

      var subtrash = testServer.addFolder(
        'Subtrash', folderType.Mail, trash.folderId);
      testServer.addFolder(
        'Subsubtrash', folderType.Inbox, subtrash.folderId);

      var folder = testServer.addFolder(
        'Folder', folderType.Mail);
      testServer.addFolder(
        'Subfolder', folderType.Inbox, folder.folderId);
    });
  }

  var testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true,
                              server: testServer });

  T.group('check folder list');
  T.check('check folder list', testAccount, eSync, function(T) {
    var myFolderExp = new RegExp('^' + testAccount.accountId + '/');
    var folders = testUniverse.allFoldersSlice.items.filter(function(x) {
      return myFolderExp.test(x.id);
    });

    var hierarchy = [];
    for (var i = 0; i < folders.length; i++) {
      if (folders[i].depth < hierarchy.length)
        hierarchy.length = folders[i].depth;
      if (folders[i].depth === hierarchy.length)
        hierarchy.push(folders[i].name);

      eSync.expect_namedValue('path', folders[i].path);
      eSync.namedValue('path', hierarchy.join('/'));
    }
  });

  if (TEST_PARAMS.type === 'imap') {
    T.group('check folder type');
    T.check('check folder type', testAccount, eSync, function(T) {
      var validNamespace = { "personal":[{"prefix":"INBOX.","delim":"."}],
                             "other":[],
                             "shared":[
                               {"prefix":"#shared.","delim":"."},
                               {"prefix":"shared.","delim":"."}
                             ]
                           };
      var invalidNamespace =
                           { "personal":[],
                             "other":[],
                             "shared":[
                               {"prefix":"#shared.","delim":"."},
                               {"prefix":"shared.","delim":"."}
                             ]
                           };
      var folders = [
        {
          "box": {"displayName": "INBOX", "attribs": [] },
          "path": "INBOX",
          "ns": validNamespace,
          "expType": "inbox"
        },
        {
          "box": {"displayName": "INBOX", "attribs": [] },
          "path": "INBOX",
          "ns": invalidNamespace,
          "expType": "inbox"
        },
        {
          "box": {"displayName": "Sent", "attribs": [] },
          "path": "INBOX.Sent",
          "ns": validNamespace,
          "expType": "sent"
        },
        {
          "box": {"displayName": "Sent", "attribs": [] },
          "path": "Sent",
          "ns": invalidNamespace,
          "expType": "sent"
        },
        {
          "box": {"displayName": "Sent", "attribs": [] },
          "path": "INBOX.Sent",
          "ns": invalidNamespace,
          "expType": "normal"
        },
        {
          "box": {"displayName": "Sent", "attribs": [] },
          "path": "INBOX.Subfolder.Sent",
          "ns": validNamespace,
          "expType": "normal"
        },
        {
          "box": {"displayName": "Sent", "attribs": [] },
          "path": "INBOX.Subfolder.Sent",
          "ns": invalidNamespace,
          "expType": "normal"
        },
      ];
      for (var i = 0; i < folders.length; i++) {
        var box = folders[i].box;
        var path = folders[i].path;
        var ns = folders[i].ns;
        var eType = folders[i].expType;

        var fakeConn = { namespaces: ns };
        var type = testAccount.imapAccount._determineFolderType(
                     box, path, fakeConn);
        eSync.expect_namedValue('folder type', eType);
        eSync.namedValue('folder type', type);
      }
    });
  }

  T.group('cleanup');
});

}); // end define

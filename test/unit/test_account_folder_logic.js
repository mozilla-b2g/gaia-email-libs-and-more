/**
 * Account logic that currently needs to be its own file because IndexedDB
 * db reuse makes this test unhappy.
 **/

define(['rdcommon/testcontext', './resources/th_main',
        'activesync/codepages', 'mailapi/mailapi', 'exports'],
       function($tc, $th_main, $ascp, $mailapi, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_account_folder_logic' }, null,
  [$th_main.TESTHELPER], ['app']);

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
                            { universe: testUniverse,
                              imapExtensions: ['RFC2195', 'RFC6154'] }),
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

TD.commonCase('syncFolderList created offline folders', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eCheck = T.lazyLogger('check');

  ['localdrafts', 'outbox'].forEach(function(folderType) {
    T.check(eCheck, folderType + ' folder', function() {
      eCheck.expect_namedValue('has ' + folderType + ' folder?', true);
      var sent = testUniverse.allFoldersSlice.getFirstFolderWithType('sent');
      // the path should place it next to the existing drafts folder, but we
      // frequently don't have that folder, so use sent, which is our fallback
      // anyways and should be consistently located
      eCheck.expect_namedValue('path',
                               sent.path.replace(/sent.*/i, folderType));


      var folder = testUniverse.allFoldersSlice
            .getFirstFolderWithType(folderType);
      eCheck.namedValue('has ' + folderType + ' folder?', !!folder);
      eCheck.namedValue('path', folder.path);
    });
  });
});

TD.commonCase('correct folders designated as valid move targets',
  function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eCheck = T.lazyLogger('check');
  var folderMoveExps = {
    'account': false,
    'nomail': false,
    'inbox': true,
    'drafts': true,
    'localdrafts': false,
    'outbox': false,
    'sent': true,
    'trash': true,
    'archive': true,
    'junk': true,
    'starred': true,
    'important': true,
    'normal': true
  };
  function check(type) {
    T.check(eCheck, type + ' folder', function() {
      var folder = new $mailapi._MailFolder(testUniverse.MailAPI, {type: type});
      eCheck.expect_namedValue(type + ' folder is valid move target', folderMoveExps[type]);
      eCheck.namedValue(type + ' folder is valid move target', folder.isValidMoveTarget);
    });
  }

  for (var folderType in folderMoveExps) {
    check(folderType);
  }
});

TD.commonCase('normalizeFolderHierarchy', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U');
  var testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: true }),
      eCheck = T.lazyLogger('check');

  if (TEST_PARAMS.type !== 'pop3') {
    // POP3 does not have server folders.
    T.action('Move system folders under INBOX', function() {
      testAccount.testServer.moveSystemFoldersUnderneathInbox();
    });
  }

  T.action('run syncFolderList', eCheck, function(T) {
    testAccount.expect_runOp('syncFolderList',
                             { local: false, server: true, conn: true });
    eCheck.expect_event('roundtripped');
    testUniverse.universe.syncFolderList(testAccount.account, function() {
      testUniverse.MailAPI.ping(function() {
        eCheck.event('roundtripped');
      });
    });
  });

  ['outbox', 'localdrafts'].forEach(function(folderType) {
    T.check(eCheck, folderType + ' folder', function() {
      eCheck.expect_namedValue('has ' + folderType + ' folder?', true);
      var sent = testUniverse.allFoldersSlice.getFirstFolderWithType('sent');
      // the path should place it next to the existing drafts folder, but we
      // frequently don't have that folder, so use sent, which is our fallback
      // anyways and should be consistently located
      eCheck.expect_namedValue('path',
                               sent.path.replace(/sent.*/i, folderType));

      var folder = testUniverse.allFoldersSlice
            .getFirstFolderWithType(folderType);
      eCheck.namedValue('has ' + folderType + ' folder?', !!folder);
      eCheck.namedValue('path', folder.path);
    });
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
      var inbox = testServer.getFolderByPath('Inbox'),
          sent  = testServer.getFolderByPath('Sent Mail'),
          trash = testServer.getFolderByPath('Trash');

      var subinbox = testServer.addFolder('Subinbox', folderType.Mail);
      testServer.addFolder('Subsubinbox', folderType.Inbox);

      var subsent = testServer.addFolder('Subsent', folderType.Mail);
      testServer.addFolder('Subsubsent', folderType.Inbox);

      var subtrash = testServer.addFolder('Subtrash', folderType.Mail);
      testServer.addFolder('Subsubtrash', folderType.Inbox);

      var folder = testServer.addFolder('Folder', folderType.Mail);
      testServer.addFolder('Subfolder', folderType.Inbox);
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

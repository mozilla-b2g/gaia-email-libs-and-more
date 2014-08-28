/**
 * Account logic that currently needs to be its own file because IndexedDB
 * db reuse makes this test unhappy.
 **/

define(['rdcommon/testcontext', './resources/th_main',
        'activesync/codepages', 'mailapi', 'exports'],
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

  var testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse,
                              restored: true });


  if (TEST_PARAMS.type === 'activesync') {
    T.action('create test folders', function() {
      var testServer = testAccount.testServer;
      
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

  if (TEST_PARAMS.type === 'imap') {
    T.group('check folder type');
    T.check('check folder type', testAccount, eSync, function(T) {
      var validNS = { "personal":[{"prefix":"INBOX.","delimiter":"."}],
                      "other":[],
                      "shared":[
                        {"prefix":"#shared.","delimiter":"."},
                        {"prefix":"shared.","delimiter":"."}
                      ]
                    };
      var invalidNS = { "personal":[],
                        "other":[],
                        "shared":[
                          {"prefix":"#shared.","delimiter":"."},
                          {"prefix":"shared.","delimiter":"."}
                        ]
                      };
      var folders = {
        root: true,
        children: [
          { name: 'INBOX', path: 'INBOX', ns: validNS, expType: 'inbox',
            children: [
              { name: 'Sent', path: 'INBOX.Sent',
                ns: validNS, expType: 'sent' },
              { name: 'Sent', path: 'INBOX.Sent',
                ns: invalidNS, expType: 'normal' }
            ]
          },
          { name: 'INBOX', path: 'INBOX', ns: invalidNS, expType: 'inbox',
            children: [
              { name: 'Sent', path: 'INBOX.Sent',
                ns: validNS, expType: 'sent' },
              { name: 'Sent', path: 'INBOX.Sent',
                ns: invalidNS, expType: 'normal' },
              { name: 'Subfolder', path: 'INBOX.Subfolder',
                ns: validNS, expType: 'normal',
                children: [
                  { name: 'Sent', path: 'INBOX.Subfolder.Sent',
                    ns: validNS, expType: 'normal' },
                  { name: 'Sent', path: 'INBOX.Subfolder.Sent',
                    ns: invalidNS, expType: 'normal' }
                ]
              }
            ]
          },
          { name: 'Sent', path: 'Sent', ns: validNS, expType: 'sent' }
        ]
      };

      function visitFolderLevel(children) {
        children.forEach(function(node) {
          if (node.ns) {
            testAccount.imapAccount._namespaces = node.ns;
          }
          var type = testAccount.imapAccount._determineFolderType(
            node, node.path);
          eSync.expect_namedValue('folder ' + node.path, node.expType);
          eSync.namedValue('folder ' + node.path, type);
          if (node.children) {
            visitFolderLevel(node.children);
          }
        });
      }

      visitFolderLevel(folders.children);
    });
  }

  T.group('cleanup');
});

}); // end define

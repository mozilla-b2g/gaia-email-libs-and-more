/**
 * Ensure that if we connect to an IMAP server without Sent or Trash folders
 * that we will try and create them and succeed in creating them.
 *
 * This can only be done on a fake server.
 **/

define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var $th_main = require('./resources/th_main');
var deriveFolderPath = require('imap/jobs').deriveFolderPath;

/**
 * Test the folder
 */
return new LegacyGelamTest('folder path logic', function(T, RT) {
  $th_main.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check');

  var checks = [
    // The base-base of top-level folders with an empty namespace should work
    {
      label: 'empty namespace, top-level foo, no subfolders',
      name: 'foo',
      containOtherFolders: false,
      parentFolderInfo: null,
      namespace: { prefix: '', delimiter: '/' },
      expect: { path: 'foo', delimiter: '/', depth: 0 }
    },
    {
      label: 'empty namespace, top-level foo, subfolders',
      name: 'foo',
      containOtherFolders: true,
      parentFolderInfo: null,
      namespace: { prefix: '', delimiter: '/' },
      expect: { path: 'foo/', delimiter: '/', depth: 0 }
    },
    // Make sure we append the delimiter when using our parent
    {
      label: 'empty namespace, foo under inbox, slash, no subfolders',
      name: 'foo',
      containOtherFolders: false,
      parentFolderInfo: { path: 'INBOX', delimiter: '/', depth: 0 },
      namespace: { prefix: '', delimiter: '/' },
      expect: { path: 'INBOX/foo', delimiter: '/', depth: 1 }
    },
    {
      label: 'empty namespace, foo under inbox, period, no subfolders',
      name: 'foo',
      containOtherFolders: false,
      parentFolderInfo: { path: 'INBOX', delimiter: '.', depth: 0 },
      namespace: { prefix: '', delimiter: '.' },
      expect: { path: 'INBOX.foo', delimiter: '.', depth: 1 }
    },
    // But not with the subfolder flag so we get a trailing delimiter
    {
      label: 'empty namespace, foo under inbox, slash, subfolders',
      name: 'foo',
      containOtherFolders: true,
      parentFolderInfo: { path: 'INBOX', delimiter: '/', depth: 0 },
      namespace: { prefix: '', delimiter: '/' },
      expect: { path: 'INBOX/foo/', delimiter: '/', depth: 1 }
    },
    {
      label: 'empty namespace, foo under inbox, period, subfolders',
      name: 'foo',
      containOtherFolders: true,
      parentFolderInfo: { path: 'INBOX', delimiter: '.', depth: 0 },
      namespace: { prefix: '', delimiter: '.' },
      expect: { path: 'INBOX.foo.', delimiter: '.', depth: 1 }
    },
    // bare folder without explicit parent in an inbox namespace
    {
      label: 'inbox namespace, foo unparented, slash, no subfolders',
      name: 'foo',
      containOtherFolders: false,
      parentFolderInfo: null,
      namespace: { prefix: 'INBOX', delimiter: '/' },
      expect: { path: 'INBOX/foo', delimiter: '/', depth: 1 }
    },
    {
      label: 'inbox namespace, foo unparented, period, no subfolders',
      name: 'foo',
      containOtherFolders: false,
      parentFolderInfo: null,
      namespace: { prefix: 'INBOX', delimiter: '.' },
      expect: { path: 'INBOX.foo', delimiter: '.', depth: 1 }
    },
    // and again with subfolders
    {
      label: 'inbox namespace, foo unparented, slash, subfolders',
      name: 'foo',
      containOtherFolders: true,
      parentFolderInfo: null,
      namespace: { prefix: 'INBOX', delimiter: '/' },
      expect: { path: 'INBOX/foo/', delimiter: '/', depth: 1 }
    },
    {
      label: 'inbox namespace, foo unparented, period, subfolders',
      name: 'foo',
      containOtherFolders: true,
      parentFolderInfo: null,
      namespace: { prefix: 'INBOX', delimiter: '.' },
      expect: { path: 'INBOX.foo.', delimiter: '.', depth: 1 }
    },
    // Make sure that nothing weird happens if we explicitly root ourselves
    // under INBOX and we're under the INBOX namespace
    {
      label: 'inbox namespace, foo under inbox, slash, no subfolders',
      name: 'foo',
      containOtherFolders: false,
      parentFolderInfo: { path: 'INBOX', delimiter: '/', depth: 0 },
      namespace: { prefix: 'INBOX', delimiter: '/' },
      expect: { path: 'INBOX/foo', delimiter: '/', depth: 1 }
    },
    {
      label: 'inbox namespace, foo under inbox, period, no subfolders',
      name: 'foo',
      containOtherFolders: false,
      parentFolderInfo: { path: 'INBOX', delimiter: '.', depth: 0 },
      namespace: { prefix: 'INBOX', delimiter: '.' },
      expect: { path: 'INBOX.foo', delimiter: '.', depth: 1 }
    },
    // Make sure deeper paths don't explode us
    {
      label: 'empty namespace, foo under bar, slash, no subfolders',
      name: 'foo',
      containOtherFolders: false,
      parentFolderInfo: { path: 'bar', delimiter: '/', depth: 0 },
      namespace: { prefix: '', delimiter: '/' },
      expect: { path: 'bar/foo', delimiter: '/', depth: 1 }
    },
    {
      label: 'empty namespace, foo under baz/bar, slash, no subfolders',
      name: 'foo',
      containOtherFolders: false,
      parentFolderInfo: { path: 'baz/bar', delimiter: '/', depth: 1 },
      namespace: { prefix: '', delimiter: '/' },
      expect: { path: 'baz/bar/foo', delimiter: '/', depth: 2 }
    },
    // and again but with an inbox namespace
    {
      label: 'empty namespace, foo under bar, slash, no subfolders',
      name: 'foo',
      containOtherFolders: false,
      parentFolderInfo: { path: 'INBOX/bar', delimiter: '/', depth: 1 },
      namespace: { prefix: 'INBOX', delimiter: '/' },
      expect: { path: 'INBOX/bar/foo', delimiter: '/', depth: 2 }
    },
    {
      label: 'empty namespace, foo under baz/bar, slash, no subfolders',
      name: 'foo',
      containOtherFolders: false,
      parentFolderInfo: { path: 'INBOX/baz/bar', delimiter: '/', depth: 2 },
      namespace: { prefix: 'INBOX', delimiter: '/' },
      expect: { path: 'INBOX/baz/bar/foo', delimiter: '/', depth: 3 }
    },
  ];
  checks.forEach(function(check) {
    T.action(eCheck, check.label, function() {
      eCheck.expect('result',  check.expect);
      var result = deriveFolderPath(
        check.name, check.containOtherFolders, check.parentFolderInfo,
        check.namespace);
      eCheck.log('result', result, check);
    });
  });
});

TD.commonCase('create Sent and Trash folders when missing', function(T, RT) {
  T.group('setup');

  var testUniverse = T.actor('TestUniverse', 'U');

  T.group('create account and see folders created');
  var testAccount = T.actor(
    'TestAccount', 'A',
    {
      universe: testUniverse,
      // start out with only the Inbox
      folderConfig: {
        underInbox: false, // don't use INBOX. as the namespace
        folders: [] // INBOX is inescapable and eternal.  But no others!
      },
      expectDuringCreate: function() {
        // the local ops run, then the server ops
        testAccount.expect_runOp(
          'createFolder',
          { local: true, server: false });
        testAccount.expect_runOp(
          'createFolder',
          { local: true, server: false });
        testAccount.expect_runOp(
          'createFolder',
          { local: false, server: true, conn: true });
        testAccount.expect_runOp(
          'createFolder',
          { local: false, server: true, conn: true });

        eJobs.expect('createdFolder',
                     { _path: 'Trash', alreadyExists: false });
        eJobs.expect('createdFolder',
                     { _path: 'Sent', alreadyExists: false });
      }
    });
  var eCheck = T.lazyLogger('check');
  var eJobs = new T.actor('ImapJobDriver');

  // hold onto this between steps so we can test object identity
  var backendSent;
  T.check(eCheck, 'we know about the folders', function() {
    eCheck.expect('backend has trash',  true);
    eCheck.expect('backend has sent',  true);
    eCheck.expect('frontend slice has trash',  true);
    eCheck.expect('frontend slice has sent',  true);

    // The backend state should already know about the folders.
    var backendTrash = testAccount.imapAccount.getFolderByPath('Trash');
    // hold onto this at test scope
    backendSent = testAccount.imapAccount.getFolderByPath('Sent');
    eCheck.log('backend has trash', !!backendTrash, backendTrash);
    eCheck.log('backend has sent', !!backendSent, backendSent);

    // The account creation only ensured that the job ran to completion.  It
    // does not enforce that the slice updates have made their way to a
    // front-end context, so we must use ping.
    testAccount.MailAPI.ping(function() {
      var trashFolder =
        testAccount.foldersSlice.getFirstFolderWithName('Trash');
      var sentFolder =
        testAccount.foldersSlice.getFirstFolderWithName('Sent');

      eCheck.log('frontend slice has trash', !!trashFolder,
                         trashFolder);
      eCheck.log('frontend slice has sent', !!sentFolder, sentFolder);
    });
  });

  T.group('try and duplicately create when already known, fast-path out');

  T.action(eCheck, 'issue request to create Sent a second time', function() {
    testAccount.expect_runOp(
      'createFolder',
      { local: true, server: false });
    // Because we fast-path out, no connection should be acquired!
    testAccount.expect_runOp(
      'createFolder',
      { local: false, server: true, conn: false });

    eCheck.expect('same folderMeta',  true);
    testAccount.universe.createFolder(
      testAccount.accountId, null, 'Sent', 'sent', false,
      function(err, folderMeta) {
        eCheck.log('same folderMeta', folderMeta === backendSent,
                           folderMeta);
      });
  });

  T.group('forget about folder locally, try to create on server, be okay');
  T.action(eCheck, 'issue request to create Sent a third time', function() {
    // Eternal sunshine of the spotless sent folder
    testAccount.imapAccount._forgetFolder(backendSent.id);
    // (this will generate removal notifications we don't care about)

    testAccount.expect_runOp(
      'createFolder',
      { local: true, server: false });
    // a connection will be established this time.
    testAccount.expect_runOp(
      'createFolder',
      { local: false, server: true, conn: true });

    eJobs.expect('createdFolder', { _path: 'Sent', alreadyExists: true });

    // Eh, make sure we don't somehow end up with the same meta structure, that
    // would be weird.
    eCheck.expect('different folderMeta',  true);
    testAccount.universe.createFolder(
      testAccount.accountId, null, 'Sent', 'sent', false,
      function(folderMeta) {
        eCheck.log('different folderMeta', folderMeta !== backendSent,
                           folderMeta);
      });
  });

  T.group('cleanup');
});

});

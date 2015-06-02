define(function(require) {

var GelamTest = require('./resources/gelamtest');
var logic = require('logic');
var AccountHelpers = require('./resources/account_helpers');
var assert = require('./resources/assert');

/**
 * The list of input and output folder trees.  The output trees are currently
 * in the expected sorted order from the folders slice, although I'm not 100%
 * sure that it's a good idea to be baking that in here too.
 *
 * TODO: Add a lot more cases here.  For now I'm just adding enough for the
 * depth calculation regression in bug 1169589.
 */
var treeDefs = [
  {
    name: 'non-namespaced, non-special-use, all folders already exist',
    folderConfig: {
      underInbox: false,  // (this is what makes us non-namespaced)
      folders: [
        { name: 'Drafts' },
        { name: 'Sent' },
        { name: 'Trash' },
        { name: 'foo' },
        { name: 'foo/bar' },
        { name: 'foo/bar/baz' }
      ]
    },
    expectedFolders: [
      { name: 'INBOX', path: 'INBOX', type: 'inbox', depth: 0 },
      { name: 'Drafts', path: 'Drafts', type: 'drafts', depth: 0 },
      { name: 'localdrafts', path: 'localdrafts', type: 'localdrafts',
        depth: 0 },
      { name: 'outbox', path: 'outbox', type: 'outbox', depth: 0 },
      { name: 'Sent', path: 'Sent', type: 'sent', depth: 0 },
      { name: 'Trash', path: 'Trash', type: 'trash', depth: 0 },
      { name: 'foo', path: 'foo', type: 'normal', depth: 0 },
      { name: 'bar', path: 'foo/bar', type: 'normal', depth: 1 },
      { name: 'baz', path: 'foo/bar/baz', type: 'normal', depth: 2 }
    ],
  }
];


/**
 * Create a test that verifies the folder hierarchy resulting from the initial
 * syncFolderList call is as expected.  It also verifies that the folder
 * hierarchy remains the same after invoking syncFolderList a second time.
 *
 * We are endeavoring to verify the following things:
 * - Types are correctly inferred.
 * - Missing critical folders ("sent" and "trash") are automatically created.
 * - The offline/local-only "localdrafts" and "outbox" folders are created at
 *   their expected locations (given the configuration of the folder tree.)
 * - depth is correct (we regressed this once)
 *
 * This test moots some aspects of the legacy tests in the following files, but
 * they cannot yet be removed because of edge-cases we do not cover.  (And we
 * should not cover, because this test already verifies a lot.  But I believe it
 * does make sense that we define input and output folder trees and the high
 * level things we expect to be logged during the process of normalization.)
 * Also, we don't have enough treeDefs up above.
 * - test_account_folder_logic.js
 * - test_imap_create_folder.js
 */
function makeTestForFolderTree(treeDef) {
  return new GelamTest(
    'syncFolderList: ' + treeDef.name,
    {
      folderConfig: treeDef.folderConfig
    },
    function*(MailAPI) {
      this.group('setup');

      var help = new AccountHelpers(MailAPI);

      // start expecting syncFolderList (It happens as a side effect of the
      // account being created, so we need to start watching before we start
      // creating the account.)
      // XXX note that this is a backend worker-thread task, so really this
      // should be done using the backend context somehow.  Maybe the context
      // should expose a match function?  Or are we just acting as if the
      // test context can see all log events in a unified manner?  (Seems
      // reasonable enough, but there are ordering concerns, at least
      var matchSyncFolderList = logic
        .match('Account', 'runOp', { mode: 'do', type: 'syncFolderList' });

      var account = yield help.createAccount(this.options);

      // wait for the runOp to complete
      yield matchSyncFolderList;

      // make sure we hear everything
      yield help.safetyPing();

      var folderScope = {};
      logic.defineScope(folderScope, 'ExpectedFolders');

      // chain up our expectations
      var folderMatcher = logic;
      treeDef.expectedFolders.forEach(function(expFolder) {
        folderMatcher =
          folderMatcher.match('ExpectedFolders', 'folder', expFolder);
      });

      help.folders.items.forEach(function(folder) {
        logic(folderScope, 'folder',
              { name: folder.name, path: folder.path, type: folder.type,
                depth: folder.depth });
      });

      yield folderMatcher;
    });
}

return treeDefs.map(makeTestForFolderTree);
});

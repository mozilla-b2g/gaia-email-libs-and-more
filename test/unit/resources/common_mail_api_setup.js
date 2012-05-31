/**
 * Helper logic to initialize a MailAPI/MailUniverse environment.  This
 * performs a similar function to same-frame-setup.js but customized to
 * the unit test environment.
 **/

// prefixing everything since we are running in the global scope and I don't
// want the modules to accidentally see these because of a lack of shadowing.
var $_mailuniverse = require('rdimap/imapclient/mailuniverse'),
    $_mailbridge = require('rdimap/imapclient/mailbridge'),
    $_mailapi = require('rdimap/imapclient/mailapi'),
    $_fakeacct = require('rdimap/imapclient/fakeacct'),
    $_allback = require('rdimap/imapclient/allback'),
    $_log = require('rdcommon/log'),
    $_logreaper = require('rdcommon/logreaper'),
    $_Q = require('q');

// If we are using Q with debugging support, use it.
// (That's what's checked in right now...)
if ($_Q.loggingEnableFriendly) {
  $_Q.loggingEnableFriendly({
    unhandledRejections: true,
    exceptions: true,
  });
}

var MailAPI = null, MailBridge = null, MailUniverse = null;

/**
 * Creates the mail universe, and a bridge, and MailAPI.
 *
 * Use add_test() to add this function near the top of your test.
 */
function setup_mail_api() {
  MailUniverse = new $_mailuniverse.MailUniverse(
    true,
    function onUniverse() {
      var TMB = MailBridge = new $_mailbridge.MailBridge(MailUniverse);
      var TMA = MailAPI = new $_mailapi.MailAPI();
      TMA.__bridgeSend = function(msg) {
        console.log('API sending:', JSON.stringify(msg));
        window.setZeroTimeout(function() {
                                TMB.__receiveMessage(msg);
                              });
      };
      TMB.__sendMessage = function(msg) {
        console.log('Bridge sending:', JSON.stringify(msg));
        window.setZeroTimeout(function() {
                                TMA.__bridgeReceive(msg);
                              });
      };
      run_next_test();
    });

  var LogReaper = new $_logreaper.LogReaper(MailUniverse._LOG);
  do_register_cleanup(function() {
      var dumpObj = {
        schema: $_log.provideSchemaForAllKnownFabs(),
        backlog: [
          LogReaper.reapHierLogTimeSlice(),
        ],
      };
      print('##### LOGGEST-TEST-RUN-BEGIN #####\n' +
            JSON.stringify(dumpObj) + '\n' +
            '##### LOGGEST-TEST-RUN-END #####\n');
    });
}

var gAllAccountsSlice = null, gAllFoldersSlice = null;

/**
 * Create a test account as defined by TEST_PARAMS and query for the list of
 * all accounts and folders, advancing to the next test when both slices are
 * populated.
 *
 * Use add_test() to add this function near the top of your test.
 */
function setup_test_account() {
  MailAPI.tryToCreateAccount(
    {
      displayName: 'Baron von Testendude',
      emailAddress: TEST_PARAMS.emailAddress,
      password: TEST_PARAMS.password,
    },
    function accountMaybeCreated(error) {
      if (error)
        do_throw('Failed to create account: ' + TEST_PARAMS.emailAddress);

      var callbacks = $_allback.allbackMaker(
        ['accounts', 'folders'],
        function gotSlices() {
          run_next_test();
        });

      gAllAccountsSlice = MailAPI.viewAccounts(false);
      gAllAccountsSlice.oncomplete = callbacks.accounts;

      gAllFoldersSlice = MailAPI.viewFolders('navigation');
      gAllFoldersSlice.oncomplete = callbacks.folders;
    });
}

/**
 * Define a test that wants one or more IMAP folders of its own.  At the start
 * of the test we then create the given folders and fill them with messages
 * as requested by the folder definitions by using APPEND.
 *
 * Because xpcshell has limited cleanup capabilities (synchronous functions
 * only) and we don't actually want concurrent tests anyways, what we do is
 * consistently name the folders by using the test function's name and
 * concatenating the number of the folder to that name.  If said folder
 * already exists when we are setting up the test, we nuke it.
 *
 * In order to try and keep setup overhead out of our timings, we break the
 * setup out into its own test step.
 *
 * Once that's all done we invoke the test function which is responsible for
 * calling xpcshell's run_next_test() once it is finished.
 */
function add_imap_folder_test(folderDefs, testFunc) {
  // Always set the date to today at noon...
  var useDate = new Date();
  useDate.setHours(12, 0, 0, 0);
  var generator = new $_fakeacct.MessageGenerator(useDate, 'body'),
      folderPaths = [], storages = [], corpuses = [],
      rawAccount = MailUniverse.accounts[0],
      iDef = 0;

  function processNextFolder() {
    if (iDef >= folderDefs.length) {
      run_next_test();
      return;
    }
    var folderName = 'ut_' + testFunc.name + '_' + iDef;

    var existingFolder = gAllFoldersSlice.getFirstFolderWithName(folderName);
    if (existingFolder) {
      rawAccount.deleteFolder(existingFolder.id);
      gAllFoldersSlice.onsplice = function(index, howMany, added,
                                           requested, expected) {
        if (howMany !== 1) {
          console.error('Expected 1 folder to be removed but', howMany,
                        'removed?');
          do_throw('Folder deletion failed');
        }
        gAllFoldersSlice.onsplice = null;
        // just call ourselves again; existingFolder should be null now.
        processNextFolder();
      };
    }

    // the folder does not currently exist; create the folder!
    rawAccount.createFolder(null, folderName, false,
      function createdFolder(err, folderMeta) {
      if (err) {
        console.error('Problem creating folder', folderName);
        do_throw('Could not create folder');
      }
      folderPaths.push(folderName);
      var storage = account.getFolderStorageForFolderId(folderMeta.id);
      storages.push(storage);

      var folderDef = folderDefs[iDef++];
      var messageBodies = generator.makeMessages(folderDef);
      for (var i = 0; i < messageBodies.length; i++) {
        MailUniverse.appendMessage(folderDef.id, messageBodies[i]);
      }
      MailUniverse.waitForAccountOps(account, processNextFolder);
    });
  }

add_test(function setup_imap_using_test() {
  processNextFolder();
});
// By using bind, we maintain the function's name while also being able to
// provide it with arguments.
add_test(testFunc.bind(folderPaths, storages, corpuses));
}

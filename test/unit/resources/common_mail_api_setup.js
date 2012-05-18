/**
 * Helper logic to initialize a MailAPI/MailUniverse environment.  This
 * performs a similar function to same-frame-setup.js but customized to
 * the unit test environment.
 **/

// prefixing everything since we are running in the global scope and I don't
// want the modules to accidentally see these because of a lack of shadowing.
console.log('requiring mailbridge...');

var $_mailuniverse = require('rdimap/imapclient/mailuniverse'),
    $_mailbridge = require('rdimap/imapclient/mailbridge'),
    $_mailapi = require('rdimap/imapclient/mailapi'),
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

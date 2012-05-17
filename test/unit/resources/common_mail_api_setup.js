/**
 * Helper logic to initialize a MailAPI/MailUniverse environment.  This
 * performs a similar function to same-frame-setup.js but customized to
 * the unit test environment.
 **/

var $mailuniverse = require('rdimap/imapclient/mailuniverse'),
    $mailbridge = require('rdimap/imapclient/mailbridge'),
    $mailapi = require('rdimap/imapclient/mailapi'),
    $allback = require('rdimap/imapclient/allback');

var MailAPI = null, MailBridge = null, MailUniverse = null;

/**
 * Creates the mail universe, and a bridge, and MailAPI.
 *
 * Use add_test() to add this function near the top of your test.
 */
function setup_mail_api() {
  MailUniverse = new $mailuniverse.MailUniverse(
    true,
    function onUniverse() {
      var TMB = MailBridge = new $mailbridge.MailBridge(MailUniverse);
      var TMA = MailAPI = new $mailapi.MailAPI();
      TMA.__bridgeSend = function(msg) {
        window.setZeroTimeout(function() {
                                TMB.__receiveMessage(msg);
                              });
      };
      TMB.__sendMessage = function(msg) {
        window.setZeroTimeout(function() {
                                TMA.__bridgeReceive(msg);
                              });
      };
      run_next_test();
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
      emailAddress: TEST_PARAMS.account,
      password: TEST_PARAMS.password,
    },
    function accountMaybeCreated(error) {
      if (error)
        do_throw('Failed to create account: ' + TEST_PARAMS.account);

      var callbacks = $allback.allbackMaker(
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

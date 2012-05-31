define(function(require, exports, $module) {

var $log = require('rdcommon/log'),
    $mailuniverse = require('rdimap/imapclient/mailuniverse'),
    $mailbridge = require('rdimap/imapclient/mailbridge'),
    $imapacct = require('rdimap/imapclient/imapacct'),
    $imapslice = require('rdimap/imapclient/imapslice'),
    $imapjs = require('imap');


var gAccountCreated = false;

var TestImapAccountMixins = {
  __constructor: function(self, opts) {
    /**
     * Creates the mail universe, and a bridge, and MailAPI.
     */
    self.T.convenienceSetup(self, 'initializes', function() {
      self.__attachToLogger(LOGFAB.testImapAccount(self, null, self.__name));

      if (MailUniverse)
        return;

      self.expect_createUniverse();
      MailUniverse = new $_mailuniverse.MailUniverse(
        // Do not force everything to be under test; leave that to the test
        // framework.  (If we passed true, we would break the testing
        // framework's ability to log things, as well.)
        false,
        function onUniverse() {
          console.log('Universe created');
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
          self._logger.createUniverse();
        });
    });
    /**
     * Create a test account as defined by TEST_PARAMS and query for the list of
     * all accounts and folders, advancing to the next test when both slices are
     * populated.
     */
    self.T.convenienceSetup(self, 'creates test account', function() {
      if (gAccountCreated)
        return;
      self.expect_accountCreated();

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
              gAccountCreated = true;
              self._logger.accountCreated();
            });

          gAllAccountsSlice = MailAPI.viewAccounts(false);
          gAllAccountsSlice.oncomplete = callbacks.accounts;

          gAllFoldersSlice = MailAPI.viewFolders('navigation');
          gAllFoldersSlice.oncomplete = callbacks.folders;
        });
    });
  },
};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  testImapAccount: {
    type: $log.TEST_SYNTHETIC_ACTOR,
    subtype: $log.CLIENT,
    topBilling: true,

    events: {
      createUniverse: {},
      accountCreated: {},
    },
    errors: {
    },
  },
});

exports.TESTHELPER = {
  LOGFAB_DEPS: [
    LOGFAB,
    $mailuniverse.LOGFAB, $mailbridge.LOGFAB,
    $imapacct.LOGFAB, $imapslice.LOGFAB,
    $imapjs.LOGFAB,
  ],
  actorMixins: {
    testImapAccount: TestImapAccountMixins,
  }
};

});

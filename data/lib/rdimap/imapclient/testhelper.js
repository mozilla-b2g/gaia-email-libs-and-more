define(function(require, exports, $module) {

var $log = require('rdcommon/log'),
    $mailuniverse = require('rdimap/imapclient/mailuniverse'),
    $mailbridge = require('rdimap/imapclient/mailbridge'),
    $imapacct = require('rdimap/imapclient/imapacct'),
    $fakeacct = require('rdimap/imapclient/fakeacct'),
    $imapslice = require('rdimap/imapclient/imapslice'),
    $imapjs = require('imap');


var gAccountCreated = false;

var TestImapAccountMixins = {
  __constructor: function(self, opts) {
    self._eTestAccount = self.T.actor('ImapAccount', self.__name, null, self);
    self._bridgeLog = null;

    /**
     * Creates the mail universe, and a bridge, and MailAPI.
     */
    self.T.convenienceSetup(self, 'initializes', function() {
      self.__attachToLogger(LOGFAB.testImapAccount(self, null, self.__name));
      self._bridgeLog = LOGFAB.bridgeSnoop(self, self._logger, self.__name);

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
            self._bridgeLog.apiSend(msg.type, msg);
            window.setZeroTimeout(function() {
                                    TMB.__receiveMessage(msg);
                                  });
          };
          TMB.__sendMessage = function(msg) {
            self._bridgeLog.bridgeSend(msg.type, msg);
            window.setZeroTimeout(function() {
                                    TMA.__bridgeReceive(msg);
                                  });
          };
          self._logger.createUniverse();
          MailUniverse.registerBridge(TMB);
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
      self.RT.reportActiveActorThisStep(self._eTestAccount);
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

  /**
   * Create a folder and populate it with a set of messages.
   */
  createTestFolder: function(folderName, messageSetDef) {
    var self = this,
        testFolder = this.T.thing('testFolder', folderName),
        useDate = new Date();
    useDate.setHours(12, 0, 0, 0);

    testFolder.id = null;
    testFolder.mailFolder = null;
    this.T.convenienceSetup('delete test folder if it exists', function() {
      var existingFolder = gAllFoldersSlice.getFirstFolderWithName(folderName);
      if (!existingFolder)
        return;
      self.RT.reportActiveActorThisStep(self._eTestAccount);
      self.RT.reportActiveActorThisStep(self);
      self._eTestAccount.expect_deleteFolder();
      self.expect_deletionNotified();

      gAllFoldersSlice.onsplice = function(index, howMany, added,
                                           requested, expected) {
        if (howMany !== 1) {
          console.error('Expected 1 folder to be removed but', howMany,
                        'removed?');
          do_throw('Folder deletion failed');
        }
        gAllFoldersSlice.onsplice = null;
        self._logger.deletionNotified();
      };
      MailUniverse.accounts[0].deleteFolder(existingFolder.id);
    });

    this.T.convenienceSetup(self._eTestAccount, 'create test folder',function(){
      self.RT.reportActiveActorThisStep(self);
      self._eTestAccount.expect_createFolder();
      self.expect_creationNotified();

      MailUniverse.accounts[0].createFolder(null, folderName, false,
        function createdFolder(err, folderMeta) {
        if (err) {
          self._logger.folderCreationError(err);
          return;
        }
        self._logger.creationNotified();
        testFolder.id = folderMeta.id;
      });

    });

    if (messageSetDef.hasOwnProperty('count') &&
        messageSetDef.count === 0)
      return testFolder;

    this.T.convenienceSetup(this, 'populate test folder', testFolder,function(){
      var generator = new $fakeacct.MessageGenerator(useDate, 'body');
      self.expect_appendNotified();
      var messageBodies = generator.makeMessages(messageSetDef);
      for (var i = 0; i < messageBodies.length; i++) {
        MailUniverse.appendMessage(testFolder.id, messageBodies[i]);
      }
      MailUniverse.waitForAccountOps(account, function() {
        self._logger.appendNotified();
      });
    });

    return testFolder;
  },
};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  bridgeSnoop: {
    type: $log.CLIENT,
    subtype: $log.CLIENT,
    events: {
      apiSend: { type: false, msg: false },
      bridgeSend: { type: false, msg: false },
    },
  },
  testImapAccount: {
    type: $log.TEST_SYNTHETIC_ACTOR,
    subtype: $log.CLIENT,
    topBilling: true,

    events: {
      createUniverse: {},
      accountCreated: {},

      deletionNotified: {},
      creationNotified: {},

      appendNotified: {},
    },
    errors: {
      folderCreationError: { err: false },
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

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
            do_throw('Failed to create account: ' + TEST_PARAMS.emailAddress +
                     ': ' + error);

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
  do_createTestFolder: function(folderName, messageSetDef) {
    var self = this,
        testFolder = this.T.thing('testFolder', folderName),
        useDate = new Date();
    testFolder.connActor = this.T.actor('ImapFolderConn', folderName);
    useDate.setHours(12, 0, 0, 0);

    testFolder.id = null;
    testFolder.mailFolder = null;
    testFolder.messages = null;
    this.T.convenienceSetup('delete test folder if it exists', function() {
      var existingFolder = gAllFoldersSlice.getFirstFolderWithName(folderName);
      if (!existingFolder)
        return;
      self.RT.reportActiveActorThisStep(self._eTestAccount);
      self.RT.reportActiveActorThisStep(self);
      self._eTestAccount.expect_deleteFolder();
      self.expect_deletionNotified(1);

      gAllFoldersSlice.onsplice = function(index, howMany, added,
                                           requested, expected) {
        gAllFoldersSlice.onsplice = null;
        self._logger.deletionNotified(howMany);
      };
      MailUniverse.accounts[0].deleteFolder(existingFolder.id);
    });

    this.T.convenienceSetup(self._eTestAccount, 'create test folder',function(){
      self.RT.reportActiveActorThisStep(self);
      self.RT.reportActiveActorThisStep(testFolder.connActor);
      self._eTestAccount.expect_createFolder();
      self.expect_creationNotified(1);

      gAllFoldersSlice.onsplice = function(index, howMany, added,
                                           requested, expected) {
        gAllFoldersSlice.onsplice = null;
        self._logger.creationNotified(added.length);
        testFolder.mailFolder = added[0];
      };
      MailUniverse.accounts[0].createFolder(null, folderName, false,
        function createdFolder(err, folderMeta) {
        if (err) {
          self._logger.folderCreationError(err);
          return;
        }
        testFolder.id = folderMeta.id;
      });
    });

    if (messageSetDef.hasOwnProperty('count') &&
        messageSetDef.count === 0)
      return testFolder;

    this.T.convenienceSetup(this, 'populate test folder', testFolder,function(){
      var generator = new $fakeacct.MessageGenerator(useDate, 'body');
      self.expect_appendNotified();
      var messageBodies = testFolder.messages =
        generator.makeMessages(messageSetDef);
      MailUniverse.appendMessages(testFolder.id, messageBodies);
      MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
        self._logger.appendNotified();
      });
    }).timeoutMS = 400 * messageSetDef.count; // appending can take a bit.

    return testFolder;
  },

  /**
   * Add messages to an existing
   */
  do_addMessagesToFolder: function(testFolder, messageSetDef) {
  },


  /**
   * Provide a context in which to manipulate the contents of a folder by
   * getting a view of the messages in the folder, calling a user function
   * to trigger manipulations, then waiting for the mutation queue to get
   * drained.
   */
  do_manipulateFolder: function(testFolder, manipFunc) {
    var self = this;
    this.T.action(this, 'manipulates folder', testFolder, function() {
      self.expect_manipulationNotified();
      // XXX we want to put the system in a mode where the manipulations are
      // not played locally.
      var slice = MailAPI.viewFolderMessages(testFolder.mailFolder);
      slice.oncomplete = function() {
        manipFunc(slice);
        slice.die();
      };
      // Only wait on the operations completing after we are sure the bridge
      // has heard about them.
      Mail.ping(function() {
        MailUniverse.waitForAccountOpts(MailUniverse.accounts[0], function() {
          self._logger.manipulationNotified();
        });
      });
    });
  },

  do_manipulateFolderView: function(viewThing, manipFunc) {
    var self = this;
    this.T.action(this, 'manipulates folder view', viewThing, function() {
      self.expect_manipulationNotified();
      manipFunc(viewThing.slice);
      MailAPI.ping(function() {
        MailUniverse.waitForAccountOpts(MailUniverse.accounts[0], function() {
          self._logger.manipulationNotified();
        });
      });
    });
  },

  /**
   * Start/stop pretending to be offline.  In this case, pretending means that
   * we claim we are offline but do not tear down our IMAP connections.
   */
  do_pretendToBeOffline: function(beOffline) {
    this.T.convenienceSetup(
      beOffline ? 'pretend to be offline' : 'stop pretending to be offline',
      function() {
        MailUniverse.online = !beOffline;
      });
  },

  /**
   * Perform a one-shot viewing of the contents of the folder to see that we
   * get back the right thing.  Use do_openFolderView if you want to open it
   * and keep it open and detect changes, etc.
   */
  do_viewFolder: function(desc, testFolder, expectedValues, _saveToThing) {
    var self = this;
    this.T.action(this, desc, testFolder, 'using', testFolder.connActor,
                  function() {
      self.expect_messagesReported(expectedValues.count);
      if (MailUniverse.online) {
        testFolder.connActor.expect_syncDateRange_begin(null, null, null);
        testFolder.connActor.expect_syncDateRange_end(
          expectedValues.full, expectedValues.flags, expectedValues.deleted);
      }
      if (expectedValues.count) {
        self.expect_messageSubject(
          0, testFolder.messages[0].headerInfo.subject);
        self.expect_messageSubject(
          expectedValues.count - 1,
          testFolder.messages[expectedValues.count - 1].headerInfo.subject);
      }

      var slice = MailAPI.viewFolderMessages(testFolder.mailFolder);
      slice.oncomplete = function() {
        self._logger.messagesReported(slice.items.length);
        if (expectedValues.count) {
          self._logger.messageSubject(0, slice.items[0].subject);
          self._logger.messageSubject(
            expectedValues.count - 1,
            slice.items[expectedValues.count - 1].subject);
        }
        if (_saveToThing)
          _saveToThing.slice = slice;
        else
          slice.die();
      };
    });
  },

  do_openFolderView: function(viewName, testFolder, expectedValues) {
    var viewThing = this.T.thing('folderView', viewName);
    viewThing.slice = null;
    this.do_viewFolder('opens', testFolder, expectedValues, viewThing);
  },

  do_refreshFolderView: function(viewThing, expectedValues, checkHelper) {
  },

  do_closeFolderView: function(viewThing) {
    var self = this;
    this.T.action(this, 'close', viewThing, function() {
      self.expect_sliceDied(viewThing.slice.handle);
      viewThing.slice.ondead = function() {
        self._logger.sliceDied(viewThing.slice.handle);
      };
      viewThing.slice.die();
    });
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

      deletionNotified: { count: true },
      creationNotified: { count: true },
      sliceDied: { handle: true },

      appendNotified: {},
      manipulationNotified: {},

      messagesReported: { count: true },
      messageSubject: { index: true, subject: true },
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

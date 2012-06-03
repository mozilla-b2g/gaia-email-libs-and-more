define(function(require, exports, $module) {

var $log = require('rdcommon/log'),
    $mailuniverse = require('rdimap/imapclient/mailuniverse'),
    $mailbridge = require('rdimap/imapclient/mailbridge'),
    $imapacct = require('rdimap/imapclient/imapacct'),
    $fakeacct = require('rdimap/imapclient/fakeacct'),
    $imapslice = require('rdimap/imapclient/imapslice'),
    $imaputil = require('rdimap/imapclient/util'),
    $imapjs = require('imap');


var gAccountCreated = false;

var TestImapAccountMixins = {
  __constructor: function(self, opts) {
    self._eTestAccount = self.T.actor('ImapAccount', self.__name, null, self);
    self._bridgeLog = null;

    // Pick a 'now' for the purposes of our testing that does not change
    // throughout the test.  We really don't want to break because midnight
    // happened during the test run.
    self._useDate = new Date();
    self._useDate.setHours(12, 0, 0, 0);

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
        testFolder = this.T.thing('testFolder', folderName);
    testFolder.connActor = this.T.actor('ImapFolderConn', folderName);

    testFolder.id = null;
    testFolder.mailFolder = null;
    testFolder.messages = null;
    this.T.convenienceSetup('delete test folder if it exists', function() {
      var existingFolder = gAllFoldersSlice.getFirstFolderWithName(folderName);
      if (!existingFolder)
        return;
      self.RT.reportActiveActorThisStep(self._eTestAccount);
      self.RT.reportActiveActorThisStep(self);
      self._eTestAccount.expect_reuseConnection();
      self._eTestAccount.expect_releaseConnection();
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
      self._eTestAccount.expect_reuseConnection();
      self._eTestAccount.expect_releaseConnection();
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

    this._do_addMessagesToTestFolder(testFolder, 'populate test folder',
                                     messageSetDef);

    return testFolder;
  },

  _do_addMessagesToTestFolder: function(testFolder, desc, messageSetDef) {
    var self = this;
    this.T.convenienceSetup(this, desc, testFolder,function(){
      var generator = new $fakeacct.MessageGenerator(self._useDate, 'body');
      self.expect_appendNotified();
      var messageBodies = generator.makeMessages(messageSetDef);
      // no messages in there yet, just use the list as-is
      if (!testFolder.messages) {
        testFolder.messages = messageBodies;
      }
      // messages already in there, need to insert them appropriately
      else {
        for (var i = 0; i < messageBodies.length; i++) {
          var idx = $imaputil.bsearchForInsert(
            testFolder.messages, messageBodies[i],
            function (a, b) {
              // we only compare based on date because we require distinct dates
              // for this ordering, but we could track insertion sequence
              // which would correlate with UID and then be viable...
              return b.date - a.date;
            });
          testFolder.messages.splice(idx, 0, messageBodies[i]);
        }
      }
      MailUniverse.appendMessages(testFolder.id, messageBodies);
      MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
        self._logger.appendNotified();
      });
    }).timeoutMS = 400 * messageSetDef.count; // appending can take a bit.
  },

  /**
   * Add messages to an existing test folder.
   */
  do_addMessagesToFolder: function(testFolder, messageSetDef) {
    this._do_addMessagesToTestFolder(testFolder, 'add messages to',
                                     messageSetDef);
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
        // Only wait on the operations completing after we are sure the bridge
        // has heard about them.
        MailAPI.ping(function() {
          MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
            self._logger.manipulationNotified();
          });
        });
      };
    });
  },

  do_manipulateFolderView: function(viewThing, manipFunc) {
    var self = this;
    this.T.action(this, 'manipulates folder view', viewThing, function() {
      self.expect_manipulationNotified();
      manipFunc(viewThing.slice);
      MailAPI.ping(function() {
        MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
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

  _expect_dateSyncs: function(testFolder, expectedValues) {
    this.RT.reportActiveActorThisStep(testFolder.connActor);
    if (!Array.isArray(expectedValues))
      expectedValues = [expectedValues];

    var totalMessageCount = 0;
    for (var i = 0; i < expectedValues.length; i++) {
      var einfo = expectedValues[i];
      totalMessageCount += einfo.count;
      if (MailUniverse.online) {
        testFolder.connActor.expect_syncDateRange_begin(null, null, null);
        testFolder.connActor.expect_syncDateRange_end(
          einfo.full, einfo.flags, einfo.deleted);
      }
    }

    return totalMessageCount;
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
      // generate expectations for each date sync range
      var totalExpected = self._expect_dateSyncs(testFolder, expectedValues);
      // Generate overall count expectation and first and last message
      // expectations by subject.
      self.expect_messagesReported(totalExpected);
      if (totalExpected) {
        self.expect_messageSubject(
          0, testFolder.messages[0].headerInfo.subject);
        self.expect_messageSubject(
          totalExpected - 1,
          testFolder.messages[totalExpected - 1].headerInfo.subject);
      }

      var slice = MailAPI.viewFolderMessages(testFolder.mailFolder);
      slice.oncomplete = function() {
        self._logger.messagesReported(slice.items.length);
        if (totalExpected) {
          self._logger.messageSubject(0, slice.items[0].subject);
          self._logger.messageSubject(
            totalExpected - 1, slice.items[totalExpected - 1].subject);
        }
        if (_saveToThing) {
          _saveToThing.slice = slice;
        }
        else {
          slice.die();
        }
      };
    });
  },

  do_openFolderView: function(viewName, testFolder, expectedValues) {
    var viewThing = this.T.thing('folderView', viewName);
    viewThing.testFolder = testFolder;
    viewThing.slice = null;
    this.do_viewFolder('opens', testFolder, expectedValues, viewThing);
    return viewThing;
  },

  _expect_headerChanges: function(expected, changeMap) {
    var i, deletionRep = {}, changeRep = {};
    for (i = 0; i < expected.deletions.length; i++) {
      deletionRep[expected.deletions[i].subject] = true;
    }
    for (i = 0; i < expected.changes.length; i++) {
      // We're not actually logging what attributes changed here; we verify
      // correctness with an assertion check that logs an error on mis-match.
      changeRep[expected.changes[i][0].subject] = true;
      changeMap[expected.changes[i][0].subject] =
        { field: expected.changes[i][1], value: expected.changes[i][2] };
    }
    this.expect_changesReported(changeRep, deletionRep);
  },

  do_refreshFolderView: function(viewThing, expectedValues, checkExpected) {
    var self = this;
    this.T.action(this, 'refreshes', viewThing, function() {
      var totalExpected = self._expect_dateSyncs(viewThing.testFolder,
                                                 expectedValues);
      self.expect_messagesReported(totalExpected);
      var changeMap = {};
      self._expect_headerChanges(checkExpected, changeMap);

      var changeRep = {}, deletionRep = {};
      viewThing.slice.onchange = function(item) {
        changeRep[item.subject] = true;
        var changeEntry = changeMap[item.subject];
        if (item[changeEntry.field] !== changeEntry.value)
          self._logger.changeMismatch(changeEntry.field, changeEntry.value);
      };
      viewThing.slice.onremove = function(item) {
        deletionRep[item.subject] = true;
      };
      viewThing.slice.oncomplete = function refreshCompleted() {
        self._logger.messagesReported(viewThing.slice.items.length);
        self._logger.changesReported(changeRep, deletionRep);

        viewThing.slice.onchange = null;
        viewThing.slice.onremove = null;
      };
      viewThing.slice.refresh();
    });
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

      changesReported: { changes: true, deletions: true },
    },
    errors: {
      folderCreationError: { err: false },
      changeMismatch: { field: false, expectedValue: false },
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

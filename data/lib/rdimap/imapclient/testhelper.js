define(function(require, exports, $module) {

var $log = require('rdcommon/log'),
    $mailuniverse = require('rdimap/imapclient/mailuniverse'),
    $mailbridge = require('rdimap/imapclient/mailbridge'),
    $imapacct = require('rdimap/imapclient/imapacct'),
    $fakeacct = require('rdimap/imapclient/fakeacct'),
    $imapslice = require('rdimap/imapclient/imapslice'),
    $imaputil = require('rdimap/imapclient/util'),
    $imapjs = require('imap'),
    $smtpacct = require('rdimap/imapclient/smtpacct');


var TestUniverseMixins = {
  __constructor: function(self, opts) {
    self.eUniverse = self.T.actor('MailUniverse', self.__name, null, self);

    self._bridgeLog = null;

    // self-registered accounts that belong to this universe
    self.__testAccounts = [];
    // Self-registered accounts that think they are getting restored; we use
    // this to let them hook into the universe bootstrap process when their
    // corresponding loggers will be created.
    self.__restoredAccounts = [];

    // Pick a 'now' for the purposes of our testing that does not change
    // throughout the test.  We really don't want to break because midnight
    // happened during the test run.
    // Of course, we don't want to future-date things and have servers be
    // mad at us either, so let's have yesterday be our current time.  We use
    // our time-warp functionality on the server to make this okay.
    self._useDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    self._useDate.setHours(12, 0, 0, 0);
    $imapslice.TEST_LetsDoTheTimewarpAgain(self._useDate);

    /**
     * Creates the mail universe, and a bridge, and MailAPI.
     */
    self.T.convenienceSetup(self, 'initializes', self.eUniverse, function() {
      self.__attachToLogger(LOGFAB.testUniverse(self, null, self.__name));
      self._bridgeLog = LOGFAB.bridgeSnoop(self, self._logger, self.__name);

      for (var iAcct = 0; iAcct < self.__restoredAccounts.length; iAcct++) {
        var testAccount = self.__restoredAccounts[iAcct];
        testAccount._expect_restore();
      }

      self.expect_createUniverse();
      MailUniverse = self.universe = new $_mailuniverse.MailUniverse(
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
  },

  do_saveState: function() {
    var self = this;
    this.T.action('save state', function() {
      for (var i = 0; i < self.__testAccounts.length; i++) {
        self.__testAccounts[i].expect_saveState();
      }
      self.universe.saveUniverseState();
    });
  },

  do_shutdown: function() {
    var self = this;
    this.T.convenienceSetup('shutdown', this, this.__testAccounts, function() {
      for (var i = 0; i < self.__testAccounts.length; i++) {
        self.__testAccounts[i].expect_shutdown();
      }
      self.universe.shutdown();
    });
  },

  /**
   * Start/stop pretending to be offline.  In this case, pretending means that
   * we claim we are offline but do not tear down our IMAP connections.
   */
  do_pretendToBeOffline: function(beOffline, runBefore) {
    var step = this.T.convenienceSetup(
      beOffline ? 'go offline' : 'go online',
      function() {
        if (runBefore)
          runBefore();
        window.navigator.connection.TEST_setOffline(beOffline);
      });
    // the step isn't boring if we add expectations to it.
    if (runBefore)
      step.log.boring(false);
  },

};

var TestImapAccountMixins = {
  __constructor: function(self, opts) {
    self.eImapAccount = self.T.actor('ImapAccount', self.__name, null, self);
    self.eSmtpAccount = self.T.actor('SmtpAccount', self.__name, null, self);

    if (!opts.universe)
      throw new Error("Universe not specified!");
    if (!opts.universe.__testAccounts)
      throw new Error("Universe is not of the right type: " + opts.universe);

    self.universe = null;
    self.testUniverse = opts.universe;
    self.testUniverse.__testAccounts.push(this);
    self._useDate = self.testUniverse._useDate;

    if (opts.restored) {
      self.testUniverse.__restoredAccounts.push(this);
    }
    else {
      self._do_createAccount();
    }
  },

  expect_shutdown: function() {
    this.RT.reportActiveActorThisStep(this.eImapAccount);
    this.eImapAccount.expectOnly__die();
    this.RT.reportActiveActorThisStep(this.eSmtpAccount);
    this.eSmtpAccount.expectOnly__die();
  },

  expect_saveState: function() {
    this.RT.reportActiveActorThisStep(this.eImapAccount);
    this.eImapAccount.expect_saveAccountState_begin();
    this.eImapAccount.expect_saveAccountState_end();
  },

  _expect_restore: function() {
    this.RT.reportActiveActorThisStep(this.eImapAccount);
    this.RT.reportActiveActorThisStep(this.eSmtpAccount);
  },

  _do_createAccount: function() {
    var self = this;
    /**
     * Create a test account as defined by TEST_PARAMS and query for the list of
     * all accounts and folders, advancing to the next test when both slices are
     * populated.
     */
    self.T.convenienceSetup(self, 'creates test account', function() {
      self.__attachToLogger(LOGFAB.testImapAccount(self, null, self.__name));

      self.RT.reportActiveActorThisStep(self.eImapAccount);
      self.RT.reportActiveActorThisStep(self.eSmtpAccount);
      self.expect_accountCreated();

      self.universe = self.testUniverse.universe;

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
              self._logger.accountCreated();
            });

          gAllAccountsSlice = self.allAccountsSlice =
            MailAPI.viewAccounts(false);
          gAllAccountsSlice.oncomplete = callbacks.accounts;

          gAllFoldersSlice = self.allFoldersSlice = MailAPI.viewFolders('navigation');
          gAllFoldersSlice.oncomplete = callbacks.folders;
        });
    }).timeoutMS = 5000; // there can be slow startups...
  },

  /**
   * Create a folder and populate it with a set of messages.
   */
  do_createTestFolder: function(folderName, messageSetDef) {
    var self = this,
        testFolder = this.T.thing('testFolder', folderName);
    testFolder.connActor = this.T.actor('ImapFolderConn', folderName);
    testFolder.storageActor = this.T.actor('ImapFolderStorage', folderName);

    testFolder.id = null;
    testFolder.mailFolder = null;
    testFolder.messages = null;
    testFolder._approxMessageCount = messageSetDef.count;
    this.T.convenienceSetup('delete test folder if it exists', function() {
      var existingFolder = gAllFoldersSlice.getFirstFolderWithName(folderName);
      if (!existingFolder)
        return;
      self.RT.reportActiveActorThisStep(self.eImapAccount);
      self.RT.reportActiveActorThisStep(self);
      self.eImapAccount.expect_reuseConnection();
      self.eImapAccount.expect_releaseConnection();
      self.eImapAccount.expect_deleteFolder();
      self.expect_deletionNotified(1);

      gAllFoldersSlice.onsplice = function(index, howMany, added,
                                           requested, expected) {
        gAllFoldersSlice.onsplice = null;
        self._logger.deletionNotified(howMany);
      };
      MailUniverse.accounts[0].deleteFolder(existingFolder.id);
    });

    this.T.convenienceSetup(self.eImapAccount, 'create test folder',function(){
      self.RT.reportActiveActorThisStep(self);
      self.RT.reportActiveActorThisStep(testFolder.connActor);
      self.RT.reportActiveActorThisStep(testFolder.storageActor);
      self.eImapAccount.expect_reuseConnection();
      self.eImapAccount.expect_releaseConnection();
      self.eImapAccount.expect_createFolder();
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
      self.RT.reportActiveActorThisStep(self.eImapAccount);
      self.universe._testModeDisablingLocalOps = true;
      var generator = new $fakeacct.MessageGenerator(self._useDate, 'body');

      // the append will need to check out and check back-in a connection
      self.eImapAccount.expect_runOp_begin('do', 'append');
      self.eImapAccount.expect_reuseConnection();
      self.eImapAccount.expect_releaseConnection();
      self.eImapAccount.expect_runOp_end('do', 'append');
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
        self.universe._testModeDisablingLocalOps = false;
      });
    }).timeoutMS = 1000 + 600 * messageSetDef.count; // appending can take a bit.
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
  do_manipulateFolder: function(testFolder, noLocal, manipFunc) {
    var self = this;
    this.T.action(this, 'manipulates folder', testFolder, function() {
      if (noLocal)
        self.universe._testModeDisablingLocalOps = true;
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
            if (noLocal)
              self.universe._testModeDisablingLocalOps = false;
          });
        });
      };
    });
  },

  do_manipulateFolderView: function(viewThing, noLocal, manipFunc) {
    var self = this;
    this.T.action(this, 'manipulates folder view', viewThing, function() {
      if (noLocal)
        self.universe._testModeDisablingLocalOps = true;
      self.expect_manipulationNotified();
      manipFunc(viewThing.slice);
      MailAPI.ping(function() {
        MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
          self._logger.manipulationNotified();
          if (noLocal)
            self.universe._testModeDisablingLocalOps = false;
        });
      });
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
    }).timeoutMS = 1000 + 400 * testFolder._approxMessageCount; // (varies with N)
  },

  do_openFolderView: function(viewName, testFolder, expectedValues) {
    var viewThing = this.T.thing('folderView', viewName);
    viewThing.testFolder = testFolder;
    viewThing.slice = null;
    this.do_viewFolder('opens', testFolder, expectedValues, viewThing);
    return viewThing;
  },

  /**
   * @args[
   *   @param[viewThing]
   *   @param[expected @dict[
   *     @key[changes @listof[
   *       @list[MailHeader attrName attrValue]{
   *         The header that we expect to change, and the name of the field
   *         that we expect to change and the value we expect it to have after
   *         the change.  We don't know what the previous value is and the
   *         the notification does not currently compute the field that changed,
   *         so be careful about ensuring that the value didn't start out with
   *         the right value.
   *       }
   *     ]
   *     @key[deletions @listof[MailHeader]]{
   *       The MailHeader that we expect to be deleted.
   *     }
   *   ]]
   *  @param[completeCheckOn #:optional @oneof[
   *    @default{
   *      The slice's oncomplete method is used.
   *    }
   *    @case['roundtrip']{
   *      Expect that we will have heard all modifications by the time a ping
   *      issued during the call has its callback invoked.  (Make sure to call
   *      this method after issuing the mutations for this to work out...)
   *    }
   * ]
   */
  expect_headerChanges: function(viewThing, expected, completeCheckOn) {
    this.RT.reportActiveActorThisStep(this);
    this.RT.reportActiveActorThisStep(this.eImapAccount);

    var changeMap = {}, self = this;
    // - generate expectations and populate changeMap
    var i, iExp, expDeletionRep = {}, expChangeRep = {};
    for (i = 0; i < expected.deletions.length; i++) {
      expDeletionRep[expected.deletions[i].subject] = true;
    }
    for (i = 0; i < expected.changes.length; i++) {
      var change = expected.changes[i];
      // We're not actually logging what attributes changed here; we verify
      // correctness with an assertion check that logs an error on mis-match.
      expChangeRep[change[0].subject] = true;
      // There may be more than one attribute to check.
      // (And eventually, there may need to be set-ish checks like for custom
      // tags.)
      var expChanges = changeMap[change[0].subject] = [];
      for (iExp = 1; iExp < change.length; iExp += 2) {
        expChanges.push({ field: change[iExp], value: change[iExp+1] });
      }
    }
    this.expect_changesReported(expChangeRep, expDeletionRep);

    // - listen for the changes
    var changeRep = {}, deletionRep = {};
    viewThing.slice.onchange = function(item) {
      changeRep[item.subject] = true;
      var changeEntries = changeMap[item.subject];
      changeEntries.forEach(function(changeEntry) {
        if (item[changeEntry.field] !== changeEntry.value)
          self._logger.changeMismatch(changeEntry.field, changeEntry.value);
      });
    };
    viewThing.slice.onremove = function(item) {
      deletionRep[item.subject] = true;
    };
    function completed() {
      if (!completeCheckOn)
        self._logger.messagesReported(viewThing.slice.items.length);
      self._logger.changesReported(changeRep, deletionRep);

      viewThing.slice.onchange = null;
      viewThing.slice.onremove = null;
    };
    if (completeCheckOn === 'roundtrip')
      MailAPI.ping(completed);
    else
      viewThing.slice.oncomplete = completed;
  },

  do_refreshFolderView: function(viewThing, expectedValues, checkExpected) {
    var self = this;
    this.T.action(this, 'refreshes', viewThing, function() {
      var totalExpected = self._expect_dateSyncs(viewThing.testFolder,
                                                 expectedValues);
      self.expect_messagesReported(totalExpected);
      self.expect_headerChanges(viewThing, checkExpected);
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
  testUniverse: {
    type: $log.TEST_SYNTHETIC_ACTOR,
    subtype: $log.DAEMON,
    topBilling: true,

    events: {
      createUniverse: {},
    },
  },
  testImapAccount: {
    type: $log.TEST_SYNTHETIC_ACTOR,
    subtype: $log.CLIENT,
    topBilling: true,

    events: {
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
    $smtpacct.LOGFAB,
  ],
  actorMixins: {
    testUniverse: TestUniverseMixins,
    testImapAccount: TestImapAccountMixins,
  }
};

});

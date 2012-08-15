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

    var lazyConsole = self.T.lazyLogger('console');

    gConsoleLogFunc = function(msg) {
      lazyConsole.value(msg);
    };

    if (!opts)
      opts = {};

    self.universe = null;
    self.MailAPI = null;

    self._bridgeLog = null;

    // self-registered accounts that belong to this universe
    self.__testAccounts = [];
    // Self-registered accounts that think they are getting restored; we use
    // this to let them hook into the universe bootstrap process when their
    // corresponding loggers will be created.
    self.__restoredAccounts = [];

    self.__folderConnLoggerSoup = {};
    self.__folderStorageLoggerSoup = {};

    // Pick a 'now' for the purposes of our testing that does not change
    // throughout the test.  We really don't want to break because midnight
    // happened during the test run.
    // Of course, we don't want to future-date things and have servers be
    // mad at us either, so let's have yesterday be our current time.  We use
    // our time-warp functionality on the server to make this okay.
    if (!opts.hasOwnProperty('realDate') || opts.realDate === false) {
      self._useDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      self._useDate.setHours(12, 0, 0, 0);
      $imapslice.TEST_LetsDoTheTimewarpAgain(self._useDate);
      var DISABLE_THRESH_USING_FUTURE = -60 * 60 * 1000;
      // These are all the default values that tests code against by default.
      // If a test wants to use different values,
      $imapslice.TEST_adjustSyncValues({
        fillSize: 15,
        days: 7,
        scaleFactor: 1.6,
        // We don't want to test this at scale as part of our unit tests, so
        // crank it way up so we don't ever accidentally run into this.
        bisectThresh: 2000,
        tooMany: 2000,
        refreshNonInbox: DISABLE_THRESH_USING_FUTURE,
        refreshInbox: DISABLE_THRESH_USING_FUTURE,
        oldIsSafeForRefresh: DISABLE_THRESH_USING_FUTURE,
        refreshOld: DISABLE_THRESH_USING_FUTURE,
        useRangeNonInbox: DISABLE_THRESH_USING_FUTURE,
        useRangeInbox: DISABLE_THRESH_USING_FUTURE
      });
    }
    else {
      self._useDate = new Date();
    }

    /**
     * Creates the mail universe, and a bridge, and MailAPI.
     */
    self.T.convenienceSetup(self, 'initializes', self.eUniverse, function() {
      self.__attachToLogger(LOGFAB.testUniverse(self, null, self.__name));
      self._bridgeLog = LOGFAB.bridgeSnoop(self, self._logger, self.__name);

      self.RT.captureAllLoggersByType(
        'ImapFolderConn', self.__folderConnLoggerSoup);
      self.RT.captureAllLoggersByType(
        'ImapFolderStorage', self.__folderStorageLoggerSoup);

      for (var iAcct = 0; iAcct < self.__restoredAccounts.length; iAcct++) {
        var testAccount = self.__restoredAccounts[iAcct];
        testAccount._expect_restore();
      }

      self.expect_createUniverse();

      self.expect_queriesIssued();
      var callbacks = $_allback.allbackMaker(
        ['accounts', 'folders'],
        function gotSlices() {
          self._logger.queriesIssued();
        });

      MailUniverse = self.universe = new $_mailuniverse.MailUniverse(
        function onUniverse() {
          console.log('Universe created');
          var TMB = MailBridge = new $_mailbridge.MailBridge(self.universe);
          var TMA = MailAPI = self.MailAPI = new $_mailapi.MailAPI();
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


          gAllAccountsSlice = self.allAccountsSlice =
            self.MailAPI.viewAccounts(false);
          gAllAccountsSlice.oncomplete = callbacks.accounts;

          gAllFoldersSlice = self.allFoldersSlice =
            self.MailAPI.viewFolders('navigation');
          gAllFoldersSlice.oncomplete = callbacks.folders;
        });
    });
    self.T.convenienceDeferredCleanup(self, 'cleans up', self.eUniverse,
                                      function() {
      if (self.universe) {
        for (var i = 0; i < self.__testAccounts.length; i++) {
          self.__testAccounts[i].expect_shutdown();
        }
        self.universe.shutdown();
      }
    });
  },

  do_timewarpNow: function(useAsNowTS, humanMsg) {
    var self = this;
    this.T.convenienceSetup(humanMsg, function() {
      self._useDate = useAsNowTS;
      for (var i = 0; i < self.__testAccounts.length; i++) {
        self.__testAccounts[i]._useDate = useAsNowTS;
      }
      $imapslice.TEST_LetsDoTheTimewarpAgain(useAsNowTS);
    });
  },

  do_adjustSyncValues: function(useSyncValues) {
    this.T.convenienceSetup('adjust sync values for test', function() {
      $imapslice.TEST_adjustSyncValues(useSyncValues);
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

  /**
   * Issue range queries on the database, failing if rows are present in any
   * of the given
   */
  help_checkDatabaseDoesNotContain: function(tablesAndKeyPrefixes) {
    var self = this;
    var idb = self.universe._db._db,
        desiredStores = [], i, checkArgs;

    for (i = 0; i < tablesAndKeyPrefixes.length; i++) {
      checkArgs = tablesAndKeyPrefixes[i];
      desiredStores.push(checkArgs.table);
    }
    var trans = idb.transaction(desiredStores, 'readonly');

    tablesAndKeyPrefixes.forEach(function(checkArgs) {
      self.expect_dbRowPresent(checkArgs.table, checkArgs.prefix, false);
      var store = trans.objectStore(checkArgs.table),
          range = IDBKeyRange.bound(checkArgs.prefix,
                                    checkArgs.prefix + '\ufff0',
                                    false, false),
          req = store.get(range);
      req.onerror = function(event) {
        self._logger.dbProblem(event.target.errorCode);
      };
      req.onsuccess = function() {
        self._logger.dbRowPresent(
          checkArgs.table, checkArgs.prefix, req.result !== undefined);
      };
    });
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

    self.accountId = null;
    self.universe = null;
    self.MailAPI = null;
    self.testUniverse = opts.universe;
    self.testUniverse.__testAccounts.push(this);
    self._useDate = self.testUniverse._useDate;
    self._hasConnection = false;

    if (opts.restored) {
      self.testUniverse.__restoredAccounts.push(this);
      self._do_issueRestoredAccountQueries();
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

  _expect_connection: function() {
    if (!this._hasConnection) {
      this.eImapAccount.expect_createConnection();
      this._hasConnection = true;
    }
    else {
      this.eImapAccount.expect_reuseConnection();
    }
  },

  _expect_restore: function() {
    this.RT.reportActiveActorThisStep(this.eImapAccount);
    this.RT.reportActiveActorThisStep(this.eSmtpAccount);
  },

  _do_issueRestoredAccountQueries: function() {
    var self = this;
    self.T.convenienceSetup(self, 'issues helper queries', function() {
      self.__attachToLogger(LOGFAB.testImapAccount(self, null, self.__name));

      self.universe = self.testUniverse.universe;
      self.MailAPI = self.testUniverse.MailAPI;
      self.accountId = self.universe.accounts[
                         self.testUniverse.__testAccounts.indexOf(self)].id;
    });
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
      self.MailAPI = self.testUniverse.MailAPI;

      // we expect the connection to be reused and release to sync the folders
      self._hasConnection = true;
      self._expect_connection();
      self.eImapAccount.expect_releaseConnection();
      // we expect the account state to be saved after syncing folders
      self.eImapAccount.expect_saveAccountState_begin();
      self.eImapAccount.expect_saveAccountState_end();

      self.MailAPI.tryToCreateAccount(
        {
          displayName: TEST_PARAMS.name,
          emailAddress: TEST_PARAMS.emailAddress,
          password: TEST_PARAMS.password,
        },
        function accountMaybeCreated(error) {
          if (error)
            do_throw('Failed to create account: ' + TEST_PARAMS.emailAddress +
                     ': ' + error);
          self._logger.accountCreated();
          self.accountId = self.universe.accounts[
                             self.testUniverse.__testAccounts.indexOf(self)].id;
console.log('ACREATE', self.accountId, self.testUniverse.__testAccounts.indexOf(self));
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
    testFolder._liveSliceThings = [];
    this.T.convenienceSetup('delete test folder if it exists', function() {
      var existingFolder = gAllFoldersSlice.getFirstFolderWithName(folderName);
      if (!existingFolder)
        return;
      self.RT.reportActiveActorThisStep(self.eImapAccount);
      self.RT.reportActiveActorThisStep(self);
      self._expect_connection();
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
      self._expect_connection();
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

  do_useExistingFolder: function(folderName, suffix, oldFolder) {
    var self = this,
        testFolder = this.T.thing('testFolder', folderName + suffix);
    testFolder.connActor = this.T.actor('ImapFolderConn', folderName);
    testFolder.storageActor = this.T.actor('ImapFolderStorage', folderName);
    testFolder.messages = null;
    testFolder._liveSliceThings = [];
    this.T.convenienceSetup('find test folder', testFolder, function() {
      testFolder.mailFolder = gAllFoldersSlice.getFirstFolderWithName(
                                folderName);
      testFolder.id = testFolder.mailFolder.id;
      if (oldFolder)
        testFolder.messages = oldFolder.messages;

      testFolder.connActor.__attachToLogger(
        self.testUniverse.__folderConnLoggerSoup[testFolder.id]);
      testFolder.storageActor.__attachToLogger(
        self.testUniverse.__folderStorageLoggerSoup[testFolder.id]);
    });
    return testFolder;
  },

  _do_addMessagesToTestFolder: function(testFolder, desc, messageSetDef) {
    var self = this;
    this.T.convenienceSetup(this, desc, testFolder,function(){
      self.RT.reportActiveActorThisStep(self.eImapAccount);
      self.universe._testModeDisablingLocalOps = true;

      // the append will need to check out and check back-in a connection
      self.eImapAccount.expect_runOp_begin('do', 'append');
      if (testFolder._liveSliceThings.length === 0) {
        self._expect_connection();
        self.eImapAccount.expect_releaseConnection();
      }
      self.eImapAccount.expect_runOp_end('do', 'append');
      self.expect_appendNotified();

      var messageBodies;
      if (messageSetDef instanceof Function) {
        messageBodies = messageSetDef();
      }
      else {
        var generator = new $fakeacct.MessageGenerator(self._useDate, 'body');
        messageBodies = generator.makeMessages(messageSetDef);
      }
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
      self.RT.reportActiveActorThisStep(self.eImapAccount);
      if (self.universe.online) {
        // Turn on set matching since connection reuse and account saving are
        // not strongly ordered, nor do they need to be.
        self.eImapAccount.expectUseSetMatching();
        self._expect_connection();
        self.expect_saveState();
      }
      self.eImapAccount.asyncEventsAreComingDoNotResolve();

      // XXX we want to put the system in a mode where the manipulations are
      // not played locally.
      var slice = self.MailAPI.viewFolderMessages(testFolder.mailFolder);
      slice.oncomplete = function() {
        manipFunc(slice);
        if (self.universe.online)
          self.eImapAccount.expect_releaseConnection();
        self.eImapAccount.asyncEventsAllDoneDoResolve();

        // Only wait on the operations completing after we are sure the bridge
        // has heard about them.
        self.MailAPI.ping(function() {
          MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
            // Only kill the slice after the ops complete so the slice stays
            // alive and so there is less connection reuse flapping.
            slice.ondead = function() {
              self._logger.manipulationNotified();
            };
            slice.die();

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
      self.MailAPI.ping(function() {
        MailUniverse.waitForAccountOps(MailUniverse.accounts[0], function() {
          self._logger.manipulationNotified();
          if (noLocal)
            self.universe._testModeDisablingLocalOps = false;
        });
      });
    });
  },

  expect_runOp: function(jobName, accountSave) {
    this.RT.reportActiveActorThisStep(this.eImapAccount);
    this.eImapAccount.expect_runOp_begin('local_do', jobName);
    this.eImapAccount.expect_runOp_end('local_do', jobName);
    this.eImapAccount.expect_runOp_begin('do', jobName);
    this.eImapAccount.expect_runOp_end('do', jobName);
    if (accountSave)
      this.expect_saveState();
  },

  _expect_dateSyncs: function(testFolder, expectedValues, flag) {
    this.RT.reportActiveActorThisStep(this.eImapAccount);
    this.RT.reportActiveActorThisStep(testFolder.connActor);
    if (expectedValues) {
      if (!Array.isArray(expectedValues))
        expectedValues = [expectedValues];

      var totalMessageCount = 0;
      for (var i = 0; i < expectedValues.length; i++) {
        var einfo = expectedValues[i];
        totalMessageCount += einfo.count;
        if (this.universe.online) {
          testFolder.connActor.expect_syncDateRange_begin(null, null, null);
          testFolder.connActor.expect_syncDateRange_end(
            einfo.full, einfo.flags, einfo.deleted);
        }
      }
    }
    if (this.universe.online && flag !== 'nosave') {
      this.eImapAccount.expect_saveAccountState_begin();
      this.eImapAccount.expect_saveAccountState_end();
    }
    else {
      // Make account saving cause a failure; also, connection reuse, etc.
      this.eImapAccount.expectNothing();
    }

    return totalMessageCount;
  },

  /**
   * Perform a one-shot viewing of the contents of the folder to see that we
   * get back the right thing.  Use do_openFolderView if you want to open it
   * and keep it open and detect changes, etc.
   */
  do_viewFolder: function(desc, testFolder, expectedValues, expectedFlags,
                          _saveToThing) {
    var self = this;
    this.T.action(this, desc, testFolder, 'using', testFolder.connActor,
                  function() {
      if (self.universe.online) {
        self.RT.reportActiveActorThisStep(self.eImapAccount);
        // Turn on set matching since connection reuse and account saving are
        // not strongly ordered, nor do they need to be.
        self.eImapAccount.expectUseSetMatching();
        self._expect_connection();
        if (!_saveToThing)
          self.eImapAccount.expect_releaseConnection();
      }

      // generate expectations for each date sync range
      var totalExpected = self._expect_dateSyncs(testFolder, expectedValues);
      if (expectedValues) {
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
        self.expect_sliceFlags(expectedFlags.top, expectedFlags.bottom,
                               expectedFlags.grow, 'synced');
      }

      var slice = self.MailAPI.viewFolderMessages(testFolder.mailFolder);
      slice.oncomplete = function() {
        self._logger.messagesReported(slice.items.length);
        if (totalExpected) {
          self._logger.messageSubject(0, slice.items[0].subject);
          self._logger.messageSubject(
            totalExpected - 1, slice.items[totalExpected - 1].subject);
        }
        self._logger.sliceFlags(slice.atTop, slice.atBottom,
                                slice.userCanGrowDownwards, slice.status);
        if (_saveToThing) {
          _saveToThing.slice = slice;
          testFolder._liveSliceThings.push(_saveToThing);
        }
        else {
          slice.die();
        }
      };
    }).timeoutMS = 1000 + 400 * testFolder._approxMessageCount; // (varies with N)
  },

  do_openFolderView: function(viewName, testFolder, expectedValues,
                              expectedFlags) {
    var viewThing = this.T.thing('folderView', viewName);
    viewThing.testFolder = testFolder;
    viewThing.slice = null;
    viewThing.offset = 0;
    this.do_viewFolder('opens', testFolder, expectedValues, expectedFlags,
                       viewThing);
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
  expect_headerChanges: function(viewThing, expected, expectedFlags,
                                 completeCheckOn) {
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
    this.expect_sliceFlags(expectedFlags.top, expectedFlags.bottom,
                           expectedFlags.grow, 'synced');

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
      self._logger.sliceFlags(viewThing.slice.atTop, viewThing.slice.atBottom,
                              viewThing.slice.userCanGrowDownwards,
                              viewThing.slice.status);

      viewThing.slice.onchange = null;
      viewThing.slice.onremove = null;
    };
    if (completeCheckOn === 'roundtrip')
      this.MailAPI.ping(completed);
    else
      viewThing.slice.oncomplete = completed;
  },

  do_refreshFolderView: function(viewThing, expectedValues, checkExpected,
                                 expectedFlags) {
    var self = this;
    this.T.action(this, 'refreshes', viewThing, function() {
      var totalExpected = self._expect_dateSyncs(viewThing.testFolder,
                                                 expectedValues);
      self.expect_messagesReported(totalExpected);
      self.expect_headerChanges(viewThing, checkExpected, expectedFlags);
      viewThing.slice.refresh();
    });
  },

  do_growFolderView: function(viewThing, dirMagnitude, userRequestsGrowth,
                              alreadyExists, expectedValues, expectedFlags,
                              extraFlag) {
    var self = this;
    this.T.action(this, 'grows', viewThing, function() {
      if (dirMagnitude < 0)
        viewThing.offset += dirMagnitude;

      var totalExpected = self._expect_dateSyncs(
                            viewThing.testFolder, expectedValues,
                            extraFlag) +
                          alreadyExists;
      self.expect_messagesReported(totalExpected);
      self.expect_headerChanges(viewThing, { changes: [], deletions: [] },
                                expectedFlags);
      viewThing.slice.requestGrowth(dirMagnitude, userRequestsGrowth);
    });
  },

  do_shrinkFolderView: function(viewThing, useLow, useHigh, expectedTotal,
                                expectedFlags) {
    var self = this;
    this.T.action(this, 'shrinks', viewThing, function() {
      if (useHigh === null)
        useHigh = viewThing.slice.items.length - 1;
      else if (useHigh < 0)
        useHigh += viewThing.slice.items.length;

      // note our offset for message headers...
      viewThing.offset += useLow;

      // Expect one or two removal splices, high before low
      if (useHigh + 1 < viewThing.slice.items.length) {
        self.expect_splice(useHigh + 1,
                           viewThing.slice.items.length - useHigh - 1);
      }
      if (useLow > 0) {
        self.expect_splice(0, useLow);
      }

      self.expect_messagesReported(expectedTotal);
      self.expect_messageSubject(
        0, viewThing.testFolder.messages[viewThing.offset].headerInfo.subject);
      var idxHighMessage = viewThing.offset + (useHigh - useLow);
      self.expect_messageSubject(
        useHigh - useLow,
        viewThing.testFolder.messages[idxHighMessage].headerInfo.subject);
      self.expect_sliceFlags(expectedFlags.top, expectedFlags.bottom,
                             expectedFlags.grow, 'synced');


      viewThing.slice.onsplice = function(index, howMany, added,
                                          requested, moreExpected) {
        self._logger.splice(index, howMany);
      };
      viewThing.slice.oncomplete = function() {
        viewThing.slice.onsplice = null;

        self._logger.messagesReported(viewThing.slice.items.length);
        self._logger.messageSubject(0, viewThing.slice.items[0].subject);
        self._logger.messageSubject(
          viewThing.slice.items.length - 1,
          viewThing.slice.items[viewThing.slice.items.length - 1].subject);
        self._logger.sliceFlags(
          viewThing.slice.atTop, viewThing.slice.atBottom,
          viewThing.slice.userCanGrowDownwards,
          viewThing.slice.status);
      };

      viewThing.slice.requestShrinkage(useLow, useHigh);
    });
  },

  do_closeFolderView: function(viewThing) {
    var self = this;
    this.T.action(this, 'close', viewThing, function() {
      var testFolder = viewThing.testFolder;
      var idx = testFolder._liveSliceThings.indexOf(viewThing);
      if (idx === -1)
        throw new Error('Trying to close a non-live slice thing!');
      testFolder._liveSliceThings.splice(idx, 1);
      self.expect_sliceDied(viewThing.slice.handle);
      viewThing.slice.ondead = function() {
        self._logger.sliceDied(viewThing.slice.handle);
      };
      viewThing.slice.die();
    });
  },

  /**
   * Wait for a message with the given subject to show up in the account.
   *
   * For now we repeatedly poll for the arrival of the message
   */
  do_waitForMessage: function(viewThing, expectSubject, funcOpts) {
    var self = this;
    this.T.action(this, 'wait for message', expectSubject, function() {
      self.expect_messageSubject(null, expectSubject);
      var foundIt = false;
      if (funcOpts.expect)
        funcOpts.expect();

      viewThing.slice.onadd = function(header) {
        if (header.subject !== expectSubject)
          return;
        self._logger.messageSubject(null, header.subject);
        foundIt = true;
        if (funcOpts.withMessage)
          funcOpts.withMessage(header);
      };
      function completeFunc() {
        if (foundIt)
          return;
        setTimeout(function() {
          viewThing.slice.oncomplete = completeFunc;
          viewThing.slice.refresh();
        }, 150);
      };
      viewThing.slice.oncomplete = completeFunc;
      viewThing.slice.refresh();
    }).timeoutMS = 5000;
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
      queriesIssued: {},

      dbRowPresent: { table: true, prefix: true, present: true },
    },
    errors: {
      dbProblem: { err: false },
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

      splice: { index: true, howMany: true },
      sliceFlags: { top: true, bottom: true, grow: true, status: true },
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

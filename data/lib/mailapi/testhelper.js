define(function(require, exports, $module) {

var $log = require('rdcommon/log'),
    $mailuniverse = require('mailapi/mailuniverse'),
    $mailbridge = require('mailapi/mailbridge'),
    $maildb = require('mailapi/maildb'),
    $date = require('mailapi/date'),
    $accountcommon = require('mailapi/accountcommon'),
    $imapacct = require('mailapi/imap/account'),
    $activesyncacct = require('mailapi/activesync/account'),
    $activesyncfolder = require('mailapi/activesync/folder'),
    $fakeacct = require('mailapi/fake/account'),
    $mailslice = require('mailapi/mailslice'),
    $sync = require('mailapi/syncbase'),
    $imapfolder = require('mailapi/imap/folder'),
    $util = require('mailapi/util'),
    $errbackoff = require('mailapi/errbackoff'),
    $imapjs = require('imap'),
    $smtpacct = require('mailapi/smtp/account');

function checkFlagDefault(flags, flag, def) {
  if (!flags || !flags.hasOwnProperty(flag))
    return def;
  return flags[flag];
}

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
      $date.TEST_LetsDoTheTimewarpAgain(self._useDate);
      var DISABLE_THRESH_USING_FUTURE = -60 * 60 * 1000;
      // These are all the default values that tests code against by default.
      // If a test wants to use different values,
      $sync.TEST_adjustSyncValues({
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
        'ActiveSyncFolderConn', self.__folderConnLoggerSoup);
      self.RT.captureAllLoggersByType(
        'FolderStorage', self.__folderStorageLoggerSoup);

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

      var testOpts = {};
      if (opts.dbDelta)
        testOpts.dbVersion = $maildb.CUR_VERSION + opts.dbDelta;
      if (opts.dbVersion)
        testOpts.dbVersion = opts.dbVersion;
      if (opts.nukeDb)
        testOpts.nukeDb = opts.nukeDb;

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
        },
        testOpts);
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
      $date.TEST_LetsDoTheTimewarpAgain(useAsNowTS);
    });
  },

  do_adjustSyncValues: function(useSyncValues) {
    this.T.convenienceSetup('adjust sync values for test', function() {
      $sync.TEST_adjustSyncValues(useSyncValues);
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

  do_killQueuedOperations: function(testAccount, opsType, count, saveTo) {
    var self = this;
    this.T.action(this, 'kill operations for', testAccount, function() {
      self.expect_killedOperations(count);

      var ops = self.universe._opsByAccount[testAccount.accountId][opsType];
      var killed = ops.splice(0, ops.length);
      self._logger.killedOperations(killed.length, killed);
      if (saveTo)
        saveTo.ops = killed;
    });
  },

  do_restoreQueuedOperationsAndWait: function(testAccount, killedThing,
                                              expectFunc) {
    var self = this;
    this.T.action(this, 'restore operations from', killedThing, 'on',
                  testAccount, 'and wait', function() {
      if (expectFunc)
        expectFunc();
      self.expect_operationsDone();
      for (var i = 0; i < killedThing.ops.length; i++) {
        self.universe._queueAccountOp(testAccount.account,
                                      killedThing.ops[i]);
      }
      self.universe.waitForAccountOps(testAccount.account, function() {
        self._logger.operationsDone();
      });
    });
  },
};

/**
 * This is test account functionality common to both ActiveSync and IMAP.
 * During the constructor, we mix-in the bits
 */
var TestCommonAccountMixins = {
  __constructor: function(self, opts) {
    function mix(source, target) {
      for (var key in source) {
        target[key] = source[key];
      }
    }
    // -- IMAP
    if (TEST_PARAMS.type === 'imap') {
      mix(TestImapAccountMixins, self);
    }
    // -- ActiveSync
    else if (TEST_PARAMS.type === 'activesync') {
      mix(TestActiveSyncAccountMixins, self);
    }
    // -- Problem!
    else {
      throw new Error('Unknown account type provided by ' +
                      'GELAM_TEST_ACCOUNT_TYPE environment variable: ' +
                      TEST_PARAMS.type);
    }
    self.__constructor(self, opts);
  },

  /**
   * @args[
   *   @param[viewThing]
   *   @param[expected @dict[
   *     @key[additions #:optional @listof[MailHeader]]{
   *       List of headers/header-like things we expect to be added.  We will
   *       only test based on distinct characteristics like the subject, not
   *       values that can't/shouldn't be known a priori like the UID, etc.
   *     }
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
   *  @param[expectedFlags]
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

    var changeMap = {}, self = this;
    // - generate expectations and populate changeMap
    var i, iExp, expAdditionRep = {}, expDeletionRep = {}, expChangeRep = {};
    if (expected.hasOwnProperty('additions') && expected.additions) {
      for (i = 0; i < expected.additions.length; i++) {
        var msgThing = expected.additions[i], subject;
        expAdditionRep[msgThing.subject || msgThing.headerInfo.subject] = true;
      }
    }
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
    this.expect_changesReported(expAdditionRep, expChangeRep, expDeletionRep);
    if (expectedFlags)
      this.expect_sliceFlags(expectedFlags.top, expectedFlags.bottom,
                             expectedFlags.grow, 'synced');

    // - listen for the changes
    var additionRep = {}, changeRep = {}, deletionRep = {},
        eventCounter = 0;
    viewThing.slice.onadd = function(item) {
      additionRep[item.subject] = true;
      if (eventCounter && --eventCounter === 0)
        completed();
    };
    viewThing.slice.onchange = function(item) {
      changeRep[item.subject] = true;
      var changeEntries = changeMap[item.subject];
      if (!changeEntries) {
        self._logger.unexpectedChange(item.subject);
        return;
      }
      changeEntries.forEach(function(changeEntry) {
        if (item[changeEntry.field] !== changeEntry.value)
          self._logger.changeMismatch(changeEntry.field, changeEntry.value);
      });
      if (eventCounter && --eventCounter === 0)
        completed();
    };
    viewThing.slice.onremove = function(item) {
      deletionRep[item.subject] = true;
      if (eventCounter && --eventCounter === 0)
        completed();
    };
    var completed = function completed() {
      if (!completeCheckOn)
        self._logger.messagesReported(viewThing.slice.items.length);
      self._logger.changesReported(additionRep, changeRep, deletionRep);
      if (expectedFlags)
        self._logger.sliceFlags(viewThing.slice.atTop, viewThing.slice.atBottom,
                                viewThing.slice.userCanGrowDownwards,
                                viewThing.slice.status);

      viewThing.slice.onchange = null;
      viewThing.slice.onremove = null;
    };
    if (completeCheckOn === 'roundtrip') {
      this.MailAPI.ping(completed);
    }
    else if (typeof(completeCheckOn) === 'number') {
      eventCounter = completeCheckOn;
    } else {
      viewThing.slice.oncomplete = completed;
    }
  },

  do_openFolderView: function(viewName, testFolder, expectedValues,
                              expectedFlags, extraFlag) {
    var viewThing = this.T.thing('folderView', viewName);
    viewThing.testFolder = testFolder;
    viewThing.slice = null;
    viewThing.offset = 0;
    this.do_viewFolder('opens', testFolder, expectedValues, expectedFlags,
                       extraFlag, viewThing);
    return viewThing;
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
      // This frees up a connection.
      self._unusedConnections++;
    });
  },

  expect_runOp: function(jobName, accountSave, flags) {
    this.RT.reportActiveActorThisStep(this.eOpAccount);
    if (checkFlagDefault(flags, 'local', true)) {
      this.eOpAccount.expect_runOp_begin('local_do', jobName);
      this.eOpAccount.expect_runOp_end('local_do', jobName);
    }
    this.eOpAccount.expect_runOp_begin('do', jobName);
    // activesync does not care about connections
    if (checkFlagDefault(flags, 'conn', false)  &&
        ('expect_connection' in this)) {
      this.expect_connection();
      this.eOpAccount.expect_releaseConnection();
    }
    this.eOpAccount.expect_runOp_end('do', jobName);
    if (accountSave)
      this.expect_saveState();
  },
};

var TestImapAccountMixins = {
  __constructor: function(self, opts) {
    self.eImapAccount = self.eOpAccount =
      self.T.actor('ImapAccount', self.__name, null, self);
    self.eSmtpAccount = self.T.actor('SmtpAccount', self.__name, null, self);
    self.eBackoff = self.T.actor('BackoffEndpoint', self.__name, null, self);

    self._opts = opts;
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
    /**
     * Very simple/primitive connection book-keeping.  We only alter this in
     * a test step if the connection will outlive the step, such as when
     * opening a slice and leaving it open.  A single step that opens
     * multiple connections is beyond our automated ken and needs to either be
     * manually handled or update this common logic.
     */
    self._unusedConnections = 0;

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

  expect_connection: function() {
    if (!this._unusedConnections) {
      this.eImapAccount.expect_createConnection();
      // caller will need to decrement this if they are going to keep the
      // connection alive; we are expecting it to become available again at
      // the end of the step...
      this._unusedConnections++;
    }
    this.eImapAccount.expect_reuseConnection();
  },

  _expect_restore: function() {
    this.RT.reportActiveActorThisStep(this.eImapAccount);
    this.RT.reportActiveActorThisStep(this.eSmtpAccount);
    this.RT.reportActiveActorThisStep(this.eBackoff);
  },

  _do_issueRestoredAccountQueries: function() {
    var self = this;
    self.T.convenienceSetup(self, 'issues helper queries', function() {
      self.__attachToLogger(LOGFAB.testAccount(self, null, self.__name));

      self.universe = self.testUniverse.universe;
      self.MailAPI = self.testUniverse.MailAPI;

      self.account = self.compositeAccount =
             self.universe.accounts[
               self.testUniverse.__testAccounts.indexOf(self)];
      self.imapAccount = self.compositeAccount._receivePiece;
      self.smtpAccount = self.compositeAccount._sendPiece;
      self.accountId = self.compositeAccount.id;
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
      self.__attachToLogger(LOGFAB.testAccount(self, null, self.__name));

      self.RT.reportActiveActorThisStep(self.eImapAccount);
      self.RT.reportActiveActorThisStep(self.eSmtpAccount);
      self.RT.reportActiveActorThisStep(self.eBackoff);
      self.expect_accountCreated();

      self.universe = self.testUniverse.universe;
      self.MailAPI = self.testUniverse.MailAPI;
      self.rawAccount = null;

      // we expect the connection to be reused and release to sync the folders
      self._unusedConnections = 1;
      self.eImapAccount.expect_runOp_begin('do', 'syncFolderList');
      self.expect_connection();
      self.eImapAccount.expect_releaseConnection();
      self.eImapAccount.expect_runOp_end('do', 'syncFolderList');
      // we expect the account state to be saved after syncing folders
      self.eImapAccount.expect_saveAccountState_begin();
      self.eImapAccount.expect_saveAccountState_end();

      self.MailAPI.tryToCreateAccount(
        {
          displayName: TEST_PARAMS.name,
          emailAddress: TEST_PARAMS.emailAddress,
          password: TEST_PARAMS.password,
          accountName: self._opts.name || null,
        },
        null,
        function accountMaybeCreated(error) {
          if (error)
            do_throw('Failed to create account: ' + TEST_PARAMS.emailAddress +
                     ': ' + error);
          var idxAccount = self.testUniverse.__testAccounts.indexOf(self);
          self.account = self.compositeAccount =
            self.universe.accounts[idxAccount];
          self.imapAccount = self.compositeAccount._receivePiece;
          self.smtpAccount = self.compositeAccount._sendPiece;
          self.accountId = self.compositeAccount.id;

          // Because folder list synchronizing happens as an operation, we want
          // to wait for that operation to complete before declaring the account
          // created.
          self.universe.waitForAccountOps(self.compositeAccount, function() {
            self._logger.accountCreated();
          });
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
    testFolder.storageActor = this.T.actor('FolderStorage', folderName);

    testFolder.id = null;
    testFolder.mailFolder = null;
    testFolder.messages = null;
    testFolder._approxMessageCount = messageSetDef.count;
    testFolder._liveSliceThings = [];
    this.T.convenienceSetup('delete test folder', testFolder, 'if it exists',
                            function() {
      var existingFolder = gAllFoldersSlice.getFirstFolderWithName(folderName);
      if (!existingFolder)
        return;
      self.RT.reportActiveActorThisStep(self.eImapAccount);
      self.RT.reportActiveActorThisStep(self);
      self.expect_connection();
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

    this.T.convenienceSetup(self.eImapAccount, 'create test folder', testFolder,
                            function(){
      self.RT.reportActiveActorThisStep(self);
      self.RT.reportActiveActorThisStep(testFolder.connActor);
      self.RT.reportActiveActorThisStep(testFolder.storageActor);
      self.eImapAccount.expect_runOp_begin('local_do', 'createFolder');
      self.eImapAccount.expect_runOp_end('local_do', 'createFolder');
      self.eImapAccount.expect_runOp_begin('do', 'createFolder');
      self.expect_connection();
      self.eImapAccount.expect_releaseConnection();
      self.eImapAccount.expect_runOp_end('do', 'createFolder');
      self.expect_creationNotified(1);

      gAllFoldersSlice.onsplice = function(index, howMany, added,
                                           requested, expected) {
        gAllFoldersSlice.onsplice = null;
        self._logger.creationNotified(added.length);
        testFolder.mailFolder = added[0];
      };
      MailUniverse.createFolder(self.accountId, null, folderName, false,
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
    testFolder.storageActor = this.T.actor('FolderStorage', folderName);
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
        self.expect_connection();
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
          var idx = $util.bsearchForInsert(
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
      MailUniverse.waitForAccountOps(self.compositeAccount, function() {
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
        self.expect_connection();
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
                          extraFlag, _saveToThing) {
    var self = this;
    this.T.action(this, desc, testFolder, 'using', testFolder.connActor,
                  function() {
      if (self.universe.online) {
        self.RT.reportActiveActorThisStep(self.eImapAccount);
        // Turn on set matching since connection reuse and account saving are
        // not strongly ordered, nor do they need to be.
        self.eImapAccount.expectUseSetMatching();
        self.expect_connection();
        if (!_saveToThing)
          self.eImapAccount.expect_releaseConnection();
        else
          self._unusedConnections--;
      }

      // generate expectations for each date sync range
      var totalExpected = self._expect_dateSyncs(testFolder, expectedValues,
                                                 extraFlag);
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
                              extraFlag, willFailFlag) {
    var self = this;
    this.T.action(this, 'grows', viewThing, function() {
      var totalExpected = self._expect_dateSyncs(
                            viewThing.testFolder, expectedValues,
                            extraFlag) +
                          alreadyExists;
      self.expect_messagesReported(totalExpected);

      var expectedMessages;
      if (dirMagnitude < 0) {
        viewThing.offset += dirMagnitude;
        expectedMessages = viewThing.testFolder.messages.slice(
                             viewThing.offset,
                             viewThing.offset - dirMagnitude);
      }
      else {
        if (willFailFlag)
          expectedMessages = [];
        else
          expectedMessages = viewThing.testFolder.messages.slice(
                               viewThing.offset + alreadyExists,
                               viewThing.offset + totalExpected);
      }
      self.expect_headerChanges(
        viewThing,
        { additions: expectedMessages, changes: [], deletions: [] },
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

/**
 * For now, we create at most one server for the lifetime of the xpcshell test.
 * So we spin it up the first time we need it, and we never actually clean up
 * after it.
 */
var gActiveSyncServer = null;
var TestActiveSyncServerMixins = {
  __constructor: function(self, opts) {
    if (!opts.universe)
      throw new Error('You need to provide a universe!');
    self.T.convenienceSetup(self, 'created, listening to get port',
                            function() {
      self.__attachToLogger(LOGFAB.testActiveSyncServer(self, null,
                                                        self.__name));
      if (!gActiveSyncServer) {
        gActiveSyncServer = new ActiveSyncServer(opts.universe._useDate);
        gActiveSyncServer.start(0);
      }
      self.server = gActiveSyncServer;
      self.server.logRequest = function(request) {
        self._logger.request(request._method, request._path,
                             request._headers._headers);
      };
      self.server.logRequestBody = function(reader) {
        self._logger.requestBody(reader.dump());
        reader.rewind();
      };
      self.server.logResponse = function(request, response, writer) {
        var body;
        if (writer) {
          var reader = new $_wbxml.Reader(writer.bytes, $_ascp);
          body = reader.dump();
        }
        self._logger.response(response._httpCode, response._headers._headers,
                              body);
      };
      self.server.logResponseError = function(error) {
        self._logger.responseError(error);
      };
      var httpServer = self.server.server;
      var port = httpServer._socket.port;
      httpServer._port = port;
      // it had created the identity on port 0, which is not helpful to anyone
      httpServer._identity._initialize(port, httpServer._host, true);
      $accountcommon._autoconfigByDomain['aslocalhost'].incoming.server =
        'http://localhost:' + self.server.server._socket.port;
      self._logger.started(httpServer._socket.port);
    });
    self.T.convenienceDeferredCleanup(self, 'cleans up', function() {
      // Do not stop, pre the above, but do stop logging stuff to it.
      self.server.logRequest = null;
      self.server.logRequestBody = null;
      self.server.logResponse = null;
      /*
      self.server.stop(function() {
        self._logger.stopped();
      });
      */
    });
  },

  getFirstFolderWithType: function(folderType) {
    var folders = this.server.foldersByType[folderType];
    return folders[0];
  },
};

var TestActiveSyncAccountMixins = {
  __constructor: function(self, opts) {
    self.eAccount = self.eOpAccount =
      self.T.actor('ActiveSyncAccount', self.__name, null, self);

    self._opts = opts;
    if (!opts.universe)
      throw new Error("Universe not specified!");
    if (!opts.universe.__testAccounts)
      throw new Error("Universe is not of the right type: " + opts.universe);

    self.accountId = null;
    self.universe = null;
    self.MailAPI = null;
    self.testUniverse = opts.universe;
    self.testUniverse.__testAccounts.push(this);
    // If a server was not explicitly provided, then create one that should
    // have a lifetime of this current test step.  We use the blackboard
    // instead of the universe because a freshly started universe currently
    // does not know about the universe it is replacing.
    if (!opts.server) {
      if (!self.RT.blackboard.testActiveSyncServer) {
        self.RT.blackboard.testActiveSyncServer =
          self.T.actor('testActiveSyncServer', 'S',
                       { universe: opts.universe });
      }
      self.testServer = self.RT.blackboard.testActiveSyncServer;
    }
    else {
      self.testServer = opts.server;
    }

    // dummy attributes to be more like IMAP to reuse some logic:
    self._unusedConnections = 0;

    if (opts.restored) {
      self.testUniverse.__restoredAccounts.push(this);
      self._do_issueRestoredAccountQueries();
    }
    else {
      self._do_createAccount();
    }
  },

  _do_issueRestoredAccountQueries: function() {
    var self = this;
    self.T.convenienceSetup(self, 'issues helper queries', function() {
      self.__attachToLogger(LOGFAB.testAccount(self, null, self.__name));

      self.universe = self.testUniverse.universe;
      self.MailAPI = self.testUniverse.MailAPI;

      var idxAccount = self.testUniverse.__testAccounts.indexOf(self);
      self.account = self.universe.accounts[idxAccount];
      self.accountId = self.account.id;
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
      self.__attachToLogger(LOGFAB.testAccount(self, null, self.__name));

      self.RT.reportActiveActorThisStep(self.eAccount);
      self.expect_accountCreated();

      self.universe = self.testUniverse.universe;
      self.MailAPI = self.testUniverse.MailAPI;

      self.MailAPI.tryToCreateAccount(
        {
          displayName: 'test',
          emailAddress: 'test@aslocalhost',
          password: 'test',
          accountName: self._opts.name || null,
        },
        null,
        function accountMaybeCreated(error) {
          if (error) {
            self._logger.accountCreationError(error);
            return;
          }

          var idxAccount = self.testUniverse.__testAccounts.indexOf(self);
          self.account = self.universe.accounts[idxAccount];
          self.accountId = self.account.id;

          // Because folder list synchronizing happens as an operation, we want
          // to wait for that operation to complete before declaring the account
          // created.
          self.universe.waitForAccountOps(self.account, function() {
            self._logger.accountCreated();
          });
        });
    });
  },

  expect_shutdown: function() {
    this.RT.reportActiveActorThisStep(this.eAccount);
    this.eAccount.expectOnly__die();
  },

  expect_saveState: function() {
    this.RT.reportActiveActorThisStep(this.eAccount);
    this.eAccount.expect_saveAccountState_begin();
    this.eAccount.expect_saveAccountState_end();
  },

  _expect_restore: function() {
    this.RT.reportActiveActorThisStep(this.eAccount);
  },

  do_createTestFolder: function(folderName, messageSetDef) {
    var self = this,
        testFolder = this.T.thing('testFolder', folderName);
    testFolder.connActor = this.T.actor('ActiveSyncFolderConn', folderName);
    testFolder.storageActor = this.T.actor('FolderStorage', folderName);
    testFolder.serverFolder = null;
    testFolder.messages = null;
    testFolder._liveSliceThings = [];

    this.T.convenienceSetup(this, 'create test folder', testFolder, function() {
      self.expect_foundFolder(true);
      testFolder.serverFolder = self.testServer.server.addFolder(
        folderName, null, null, messageSetDef);
      testFolder.messages = testFolder.serverFolder.messages;
      self.expect_runOp('syncFolderList', true, { local: false });
      MailUniverse.syncFolderList(self.account, function() {
        MailAPI.ping(function() {
          testFolder.mailFolder = self.testUniverse.allFoldersSlice
                                      .getFirstFolderWithName(folderName);
          self._logger.foundFolder(!!testFolder.mailFolder,
                                   testFolder.mailFolder);
          testFolder.id = testFolder.mailFolder.id;

          testFolder.connActor.__attachToLogger(
            self.testUniverse.__folderConnLoggerSoup[testFolder.id]);
          testFolder.storageActor.__attachToLogger(
            self.testUniverse.__folderStorageLoggerSoup[testFolder.id]);
        });
      });
    });
    return testFolder;
  },

  // copy-paste-modify of the IMAP by-name variant
  do_useExistingFolderWithType: function(folderType, suffix, oldFolder) {
    var self = this,
        folderName = folderType + suffix,
        testFolder = this.T.thing('testFolder', folderName);
    testFolder.connActor = this.T.actor('ActiveSyncFolderConn', folderName);
    testFolder.storageActor = this.T.actor('FolderStorage', folderName);
    testFolder.serverFolder = null;
    testFolder.messages = null;
    testFolder._liveSliceThings = [];
    this.T.convenienceSetup(this, 'find test folder', testFolder, function() {
      self.expect_foundFolder(true);
      testFolder.serverFolder = self.testServer.getFirstFolderWithType(
        folderType);
      testFolder.messages = testFolder.serverFolder.messages;
      testFolder.mailFolder =
        self.testUniverse.allFoldersSlice.getFirstFolderWithType(folderType);
      self._logger.foundFolder(!!testFolder.mailFolder, testFolder.mailFolder);
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

  // XXX experimental attempt to re-create IMAP case; will need more love to
  // properly unify things.
  do_viewFolder: function(desc, testFolder, expectedValues, expectedFlags,
                          extraFlag, _saveToThing) {
    var self = this;
    this.T.action(this, desc, testFolder, 'using', testFolder.connActor,
                  function() {
      var totalExpected = self._expect_dateSyncs(testFolder, expectedValues,
                                                 extraFlag);
      if (expectedValues) {
        // Generate overall count expectation and first and last message
        // expectations by subject.
        self.expect_messagesReported(totalExpected);
        if (totalExpected) {
          self.expect_messageSubject(
            0, testFolder.messages[0].subject);
          self.expect_messageSubject(
            totalExpected - 1,
            testFolder.messages[totalExpected - 1].subject);
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
    });
  },

  _expect_dateSyncs: function(testFolder, expectedValues, flag) {
    this.RT.reportActiveActorThisStep(this.eAccount);
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
          if (einfo.filterType)
            testFolder.connActor.expect_inferFilterType(einfo.filterType);
          testFolder.connActor.expect_syncDateRange_end(
            einfo.full, einfo.flags, einfo.deleted);
        }
      }
    }
    if (this.universe.online && flag !== 'nosave') {
      this.eAccount.expect_saveAccountState_begin();
      this.eAccount.expect_saveAccountState_end();
    }
    else {
      // Make account saving cause a failure; also, connection reuse, etc.
      this.eAccount.expectNothing();
    }

    return totalMessageCount;
  },

  do_addMessageToFolder: function(folder, messageDef) {
    var self = this;
    this.T.convenienceSetup(this, 'add message to', folder, function() {
      self.RT.reportActiveActorThisStep(self.eAccount);
      folder.serverFolder.addMessage(messageDef);
    });
  },

  do_addMessagesToFolder: function(folder, messageSetDef) {
    var self = this;
    this.T.convenienceSetup(this, 'add messages to', folder, function() {
      self.RT.reportActiveActorThisStep(self.eAccount);
      folder.serverFolder.addMessages(messageSetDef);
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
      queriesIssued: {},

      dbRowPresent: { table: true, prefix: true, present: true },

      killedOperations: { length: true, ops: false },
      operationsDone: {},
    },
    errors: {
      dbProblem: { err: false },
    },
  },
  testAccount: {
    type: $log.TEST_SYNTHETIC_ACTOR,
    subtype: $log.CLIENT,
    topBilling: true,

    events: {
      accountCreated: {},
      foundFolder: { found: true, rep: false },

      deletionNotified: { count: true },
      creationNotified: { count: true },
      sliceDied: { handle: true },

      appendNotified: {},
      manipulationNotified: {},

      splice: { index: true, howMany: true },
      sliceFlags: { top: true, bottom: true, grow: true, status: true },
      messagesReported: { count: true },
      messageSubject: { index: true, subject: true },

      changesReported: { additions: true, changes: true, deletions: true },
    },
    errors: {
      accountCreationError: { err: false },

      folderCreationError: { err: false },
      unexpectedChange: { subject: false },
      changeMismatch: { field: false, expectedValue: false },
    },
  },
  testActiveSyncServer: {
    type: $log.SERVER,
    topBilling: true,

    events: {
      started: { port: false },
      stopped: {},

      request: { method: false, path: false, headers: false },
      requestBody: { },
      response: { status: false, headers: false },
    },
    errors: {
      responseError: { err: false },
    },
    // I am putting these under TEST_ONLY_ as a hack to get these displayed
    // differently since they are walls of text.
    TEST_ONLY_events: {
      requestBody: { body: false },
      response: { body: false },
    },
  },
});

exports.TESTHELPER = {
  LOGFAB_DEPS: [
    LOGFAB,
    $mailuniverse.LOGFAB, $mailbridge.LOGFAB,
    $mailslice.LOGFAB,
    $errbackoff.LOGFAB,
    // IMAP!
    $imapacct.LOGFAB, $imapfolder.LOGFAB,
    $imapjs.LOGFAB,
    // SMTP!
    $smtpacct.LOGFAB,
    // ActiveSync!
    $activesyncacct.LOGFAB, $activesyncfolder.LOGFAB,
  ],
  actorMixins: {
    testUniverse: TestUniverseMixins,
    testAccount: TestCommonAccountMixins,
    testActiveSyncServer: TestActiveSyncServerMixins,
  }
};

});

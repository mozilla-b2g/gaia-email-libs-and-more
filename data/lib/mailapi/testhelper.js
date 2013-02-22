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
    $activesyncjobs = require('mailapi/activesync/jobs'),
    $fakeacct = require('mailapi/fake/account'),
    $mailslice = require('mailapi/mailslice'),
    $sync = require('mailapi/syncbase'),
    $imapfolder = require('mailapi/imap/folder'),
    $imapjobs = require('mailapi/imap/jobs'),
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

    self.messageGenerator = null;

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
    if (!checkFlagDefault(opts, 'realDate', false)) {
      self._useDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      // use local noon.
      self._useDate.setHours(12, 0, 0, 0);
      $date.TEST_LetsDoTheTimewarpAgain(self._useDate);
    }
    else {
      self._useDate = new Date();
      $date.TEST_LetsDoTheTimewarpAgain(null);
    }

    if (!checkFlagDefault(opts, 'stockDefaults', false)) {
      // These are all the default values that tests code against by default.
      // If a test wants to use different values,
      $sync.TEST_adjustSyncValues({
        fillSize: 15,
        days: 7,
        growDays: 7,
        scaleFactor: 1.6,
        // We don't want to test this at scale as part of our unit tests, so
        // crank it way up so we don't ever accidentally run into this.
        bisectThresh: 2000,
        tooMany: 2000,

        // For consistency with our original tests where we would always
        // generate network traffic when opening a slice, set the threshold so
        // that it is always exceeded.  Tests that care currently explicitly
        // set this.  Note that our choice of -1 assumes that Date.now() is
        // strictly increasing; this is usually pretty safe but ntpdate can
        // do angry things, for one.
        openRefreshThresh: -1,
        // Same deal.
        growRefreshThresh: -1,
      });
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

      // Propagate the old universe's message generator so that the subject
      // numbers don't get reset.
      if (opts && opts.old && opts.old.messageGenerator)
        self.messageGenerator = opts.old.messageGenerator;

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
    this.type = TEST_PARAMS.type;
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
                             expectedFlags.growUp || false,
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
                                viewThing.slice.userCanGrowUpwards,
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
                              expectedFlags, extraFlags) {
    var viewThing = this.T.thing('folderView', viewName);
    viewThing.testFolder = testFolder;
    viewThing.slice = null;
    viewThing.offset = 0;
    viewThing.initialSynced = false;
    this.do_viewFolder('opens', testFolder, expectedValues, expectedFlags,
                       extraFlags, viewThing);
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

  do_refreshFolderView: function(viewThing, expectedValues, checkExpected,
                                 expectedFlags, extraFlags) {
    var self = this;
    this.T.action(this, 'refreshes', viewThing, function() {
      // we want this before _expect_dateSyncs because _expect_dateSyncs updates
      // testFolder.initialSynced to be true, which affects this method.
      self._expect_storage_mutexed(viewThing.testFolder, 'refresh', extraFlags);

      var totalExpected = self._expect_dateSyncs(viewThing, expectedValues,
                                                 null, 0);
      self.expect_messagesReported(totalExpected);
      self.expect_headerChanges(viewThing, checkExpected, expectedFlags);

      viewThing.slice.refresh();
    });
  },

  /**
   * Expect that a mutex operation will be run on the provided storageActor of
   * the given type.  Ignore block load and deletion notifications during this
   * time.
   */
  _expect_storage_mutexed: function(testFolder, syncType, extraFlags) {
    var storageActor = testFolder.storageActor;
    this.RT.reportActiveActorThisStep(storageActor);
    storageActor.expect_mutexedCall_begin(syncType);
    // activesync always syncs the entire folder
    if (this.type === 'activesync') {
      storageActor.expect_syncedToDawnOfTime();
    }
    else {
      switch (checkFlagDefault(extraFlags, 'syncedToDawnOfTime', false)) {
        case true:
          // per the comment on do_viewFolder, this flag has no meaning when we are
          // refreshing now that we sync FUTUREWARDS.  If we toggle it back to
          // PASTWARDS, comment out this line and things should work.
          if ((syncType === 'sync' && !testFolder.initialSynced) ||
              (syncType === 'grow'))
            storageActor.expect_syncedToDawnOfTime();
          break;
        case 'ignore':
          storageActor.ignore_syncedToDawnOfTime();
          break;
      }
    }
    storageActor.expect_mutexedCall_end(syncType);
    storageActor.ignore_loadBlock_begin();
    storageActor.ignore_loadBlock_end();
    storageActor.ignore_deleteFromBlock();
  },

  expect_runOp: function(jobName, flags) {
    var mode = checkFlagDefault(flags, 'mode', 'do'), localMode;
    switch (mode) {
      case 'do':
      case 'undo':
        localMode = 'local_' + mode;
        break;
    }

    this.RT.reportActiveActorThisStep(this.eOpAccount);
    // - local
    if (checkFlagDefault(flags, 'local', !!localMode)) {
      this.eOpAccount.expect_runOp_begin(localMode, jobName);
      this.eOpAccount.expect_runOp_end(localMode, jobName);
    }
    // - save (local)
    if (checkFlagDefault(flags, 'save', false) === true)
      this.eOpAccount.expect_saveAccountState();
    // - server (begin)
    if (checkFlagDefault(flags, 'server', true))
      this.eOpAccount.expect_runOp_begin(mode, jobName);
    // - conn, (conn) release
    if (checkFlagDefault(flags, 'conn', false)  &&
        ('expect_connection' in this)) {
      this.expect_connection();
      // (release is expected by default if we open a conn)
      if (checkFlagDefault(flags, 'release', true))
        this.eOpAccount.expect_releaseConnection();
    }
    // - release (without conn)
    else if (checkFlagDefault(flags, 'release', false)) {
      this.eOpAccount.expect_releaseConnection();
    }
    // - server (end)
    if (checkFlagDefault(flags, 'server', true))
      this.eOpAccount.expect_runOp_end(mode, jobName);
    // - save (local)
    if (checkFlagDefault(flags, 'save', false) === 'server')
      this.eOpAccount.expect_saveAccountState();
  },

  /**
   * Wait for a message with the given subject to show up in the account.
   *
   * For now we repeatedly poll for the arrival of the message
   */
  do_waitForMessage: function(viewThing, expectSubject, funcOpts) {
    var self = this;
    var testStep =
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
        // Trigger the withMessage handler only once the slice completes so that
        // we don't try and overlap with the slice's refresh.
        if (funcOpts.withMessage)
          viewThing.slice.oncomplete =
            funcOpts.withMessage.bind(funcOpts, header);
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
    });
    testStep.timeoutMS = 5000;
    return testStep;
  },

  /**
   * Locally delete the message like we heard it was deleted on the server; but
   * we won't have actually heard it from the server.  We do this outside a
   * mutex because we're a unit test hack and nothing should be going on.
   */
  fakeServerMessageDeletion: function(mailHeader) {
    var self = this;
    this.RT.reportActiveActorThisStep(this);

    var folderStorage =
          this.universe.getFolderStorageForMessageSuid(mailHeader.id);
    this.expect_deletionNotified(1);
    folderStorage.getMessageHeader(
      mailHeader.id, mailHeader.date,
      function(header) {
        folderStorage.deleteMessageHeaderAndBody(header, function() {
          self._logger.deletionNotified(1);
        });
      });
  },
};

var TestFolderMixins = {
  __constructor: function() {
    this.connActor = null;
    this.storageActor = null;
    this.id = null;
    this.mailFolder = null;
    // fake-server folder rep, if we are using a fake-server
    this.serverFolder = null;
    // messages on the server
    this.serverMessages = null;
    this.serverDeleted = [];
    // messages that should be known to the client based on the sync operations
    //  we have generated expectations for.
    this.knownMessages = [];
    this.initialSynced = false;

    this._approxMessageCount = 0;
    this._liveSliceThings = [];
  },

  /**
   * Used by a unit test to tell us that the (server) message at the given index
   * is being deleted.  For IMAP, this is accomplished by the IMAP code directly
   * manipulating flags via using modifyMessageTags, expecting the operation,
   * then expecting the operation.  We should then be called to be aware of
   * the change.
   *
   * For ActiveSync, a fake-server is currently assumed, and the manipulation
   * occurs via testFolder.serverFolder.removeMessageById().
   *
   * Ideally, in the future, we might just provide a helper method to
   * bundle all of that up into one call to manipulate the server state, be it
   * fake-server or real server.  The ActiveSync way is probably what we should
   * normalize to.
   */
  beAwareOfDeletion: function(index) {
    this.serverDeleted.push(this.serverMessages[index]);
    this.serverDeleted.push({ below: this.serverMessages[index - 1],
                              above: this.serverMessages[index + 1] });
    // ActiveYsnc's removeMessageById method will do this for us; serverMessages
    // is aliased to serverFolder.messages which gets updated.
    if (!this.serverFolder)
      this.serverMessages.splice(index, 1);
  },
};

var TestImapAccountMixins = {
  exactAttachmentSizes: false,
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
    this.eImapAccount.expect_saveAccountState();
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
      self.eImapAccount.expect_saveAccountState();

      self.MailAPI.tryToCreateAccount(
        {
          displayName: TEST_PARAMS.name,
          emailAddress: TEST_PARAMS.emailAddress,
          password: TEST_PARAMS.password,
          accountName: self._opts.name || null,
        },
        null,
        function accountMaybeCreated(error, errorDetails, account) {
          if (error) {
            self._logger.accountCreationError(error);
            return;
          }

          self.accountId = account.id;

          // Find the account instance in the MailUniverse (back-end) given the
          // wire rep of the account passed to us via our mailapi (front-end)
          // callback.
          for (var i = 0; i < self.universe.accounts.length; i++) {
            if (self.universe.accounts[i].id === account.id) {
              self.account = self.compositeAccount = self.universe.accounts[i];
              break;
            }
          }

          if (!self.account)
            do_throw('Unable to find account for ' + TEST_PARAMS.emailAddress +
                     ' (id: ' + self.accountId + ')');

          self.imapAccount = self.compositeAccount._receivePiece;
          self.smtpAccount = self.compositeAccount._sendPiece;

          // Because folder list synchronizing happens as an operation, we want
          // to wait for that operation to complete before declaring the account
          // created.
          self.universe.waitForAccountOps(self.compositeAccount, function() {
            self._logger.accountCreated();
          });
        });
    }).timeoutMS = 10000; // there can be slow startups...
  },

  /**
   * Create a folder and populate it with a set of messages.
   */
  do_createTestFolder: function(folderName, messageSetDef) {
    var self = this,
        testFolder = this.T.thing('testFolder', folderName);
    testFolder.connActor = this.T.actor('ImapFolderConn', folderName);
    testFolder.storageActor = this.T.actor('FolderStorage', folderName);

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
      self.universe.accounts[0].deleteFolder(existingFolder.id);
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
      self.universe.createFolder(self.accountId, null, folderName, false,
        function createdFolder(err, folderMeta) {
        if (err) {
          self._logger.folderCreationError(err);
          return;
        }
        testFolder.id = folderMeta.id;
      });
    });

    if (messageSetDef.hasOwnProperty('count') &&
        messageSetDef.count === 0) {
      testFolder.serverMessages = [];
      return testFolder;
    }

    this._do_addMessagesToTestFolder(testFolder, 'populate test folder',
                                     messageSetDef);

    return testFolder;
  },

  do_useExistingFolder: function(folderName, suffix, oldFolder) {
    var self = this,
        testFolder = this.T.thing('testFolder', folderName + suffix);
    testFolder.connActor = this.T.actor('ImapFolderConn', folderName);
    testFolder.storageActor = this.T.actor('FolderStorage', folderName);
    testFolder._approxMessageCount = 30;

    this.T.convenienceSetup('find test folder', testFolder, function() {
      testFolder.mailFolder = gAllFoldersSlice.getFirstFolderWithName(
                                folderName);
      testFolder.id = testFolder.mailFolder.id;
      if (oldFolder) {
        testFolder.serverMessages = oldFolder.serverMessages;
        testFolder.knownMessages = oldFolder.knownMessages;
        testFolder.serverDeleted = oldFolder.serverDeleted;
        testFolder.initialSynced = oldFolder.initialSynced;
      }

      testFolder.connActor.__attachToLogger(
        self.testUniverse.__folderConnLoggerSoup[testFolder.id]);
      testFolder.storageActor.__attachToLogger(
        self.testUniverse.__folderStorageLoggerSoup[testFolder.id]);
    });
    return testFolder;
  },

  do_useExistingFolderWithType: function(folderType, suffix, oldFolder) {
    var self = this,
        folderName = folderType + suffix,
        testFolder = this.T.thing('testFolder', folderName);
    testFolder.connActor = this.T.actor('ImapFolderConn', folderName);
    testFolder.storageActor = this.T.actor('FolderStorage', folderName);
    testFolder._approxMessageCount = 30;

    this.T.convenienceSetup('find test folder', testFolder, function() {
      testFolder.mailFolder = gAllFoldersSlice.getFirstFolderWithType(
                                folderType);
      testFolder.id = testFolder.mailFolder.id;
      if (oldFolder) {
        testFolder.serverMessages = oldFolder.serverMessages;
        testFolder.knownMessages = oldFolder.knownMessages;
        testFolder.serverDeleted = oldFolder.serverDeleted;
        testFolder.initialSynced = oldFolder.initialSynced;
      }

      testFolder.connActor.__attachToLogger(
        self.testUniverse.__folderConnLoggerSoup[testFolder.id]);
      testFolder.storageActor.__attachToLogger(
        self.testUniverse.__folderStorageLoggerSoup[testFolder.id]);
    });
    return testFolder;
  },


  /**
   * @args[
   *   @param[doNotExpect #:optional Boolean]{
   *     If true, do not add the injected messages into the set of known (to
   *     testhelper) messages so that we do not generate expectations on the
   *     headers.  Use this is adding messages to a folder that we expect to
   *     not learn about because we are testing failures.
   *   }
   * ]
   */
  _do_addMessagesToTestFolder: function(testFolder, desc, messageSetDef, opts) {
    var self = this;
    this.T.convenienceSetup(this, desc, testFolder,function(){
      self.RT.reportActiveActorThisStep(self.eImapAccount);
      self.universe._testModeDisablingLocalOps = true;

      // the append will need to check out and check back-in a connection
      self.expect_runOp(
        'append',
        { local: false, server: true, save: false,
          conn: testFolder._liveSliceThings.length === 0 });
      self.expect_appendNotified();

      var messageBodies;
      if (messageSetDef instanceof Function) {
        messageBodies = messageSetDef();
      }
      else {
        // We save/reuse our generator so that the subject numbers don't reset.
        // It was very confusing when we would add a new message with a
        // duplicate subject.
        if (!self.testUniverse.messageGenerator) {
          self.testUniverse.messageGenerator =
            new $fakeacct.MessageGenerator(self._useDate, 'body');
        }
        var generator = self.testUniverse.messageGenerator;
        generator._clock = new Date(self._useDate);
        messageBodies = generator.makeMessages(messageSetDef);
      }

      if (checkFlagDefault(opts, 'doNotExpect', false)) {
      }
      // no messages in there yet, just use the list as-is
      else if (!testFolder.serverMessages) {
        testFolder.serverMessages = messageBodies;
      }
      // messages already in there, need to insert them appropriately
      else {
        for (var i = 0; i < messageBodies.length; i++) {
          var idx = $util.bsearchForInsert(
            testFolder.serverMessages, messageBodies[i],
            function (a, b) {
              // we only compare based on date because we require distinct dates
              // for this ordering, but we could track insertion sequence
              // which would correlate with UID and then be viable...
              return b.date - a.date;
            });
          testFolder.serverMessages.splice(idx, 0, messageBodies[i]);
        }
      }
      self.universe.appendMessages(testFolder.id, messageBodies);
      self.universe.waitForAccountOps(self.compositeAccount, function() {
        self._logger.appendNotified();
        self.universe._testModeDisablingLocalOps = false;
      });
    }).timeoutMS = 1000 + 600 * messageSetDef.count; // appending can take a bit.
  },

  /**
   * Add messages to an existing test folder.
   */
  do_addMessagesToFolder: function(testFolder, messageSetDef, opts) {
    this._do_addMessagesToTestFolder(testFolder, 'add messages to',
                                     messageSetDef, opts);
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
          self.universe.waitForAccountOps(self.universe.accounts[0], function(){
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
        self.universe.waitForAccountOps(self.universe.accounts[0], function() {
          self._logger.manipulationNotified();
          if (noLocal)
            self.universe._testModeDisablingLocalOps = false;
        });
      });
    });
  },

  /**
   * Propagate messages/changes from serverMessages to knownMessages in a
   * testFolder as the result of a sync.  For places where knownMessages and
   * serverMessages overlap, we apply parallel traversal to detect additions
   * and deletions.  Where knownMessages does not yet overlap with
   * serverMessages, we just directly copy those messages across.  We only
   * generate the changes identified by `addCount` and `delCount`; we are
   * leaving it to the test cases themselves to know what is correct, we are
   * just trying to make the tests less horrible to write.
   *
   * We have limited time-stamp awareness; when doing a refresh our index
   * translation logic will expand appropriately.
   *
   * @args[
   *   @param[viewThing FolderViewThing]{
   *     The folder view in question; we want this primarily for its testFolder
   *     but also to know what messages it currently knows about.
   *   }
   *   @param[propState @oneof[null Object]]{
   *     A state object returned by a prior call to this function for use
   *     within the same _expect_dateSyncs invocation.
   *   }
   *   @param[reportCount]{
   *     The 'count' value provided in the expecedValues dicts.  This is the
   *     number of messages that will be reported from the given sync
   *     operation.
   *   }
   *   @param[addcount Number]{
   *
   *   }
   *   @param[delCount Number]{
   *   }
   *   @param[dir @oneof[
   *     @case[-1]{
   *       Futurewards
   *     }
   *     @case[0]{
   *       It's a refresh!
   *     }
   *     @case[1]{
   *       Pastwards
   *     }
   *   ]
   * ]
   */
  _propagateToKnownMessages: function(viewThing, propState, reportCount,
                                      addCount, delCount, dir) {
    if (!propState)
      propState = { offsetAdjust: 0, itemsAdjust: 0, idx: 0 };
    else
      propState.idx++;
    var testFolder = viewThing.testFolder,
        serverMessages = testFolder.serverMessages,
        knownMessages = testFolder.knownMessages,
        serverDeleted = testFolder.serverDeleted,
        seenAdded = 0, seenDeleted = 0,
        // the index of the slice's numerically lowest known message
        lowKnownIdx = viewThing.offset + propState.offsetAdjust,
        // the index of the slice's numerically highest known message
        highKnownIdx = lowKnownIdx +
          (viewThing.slice ?
             (viewThing.slice.items.length + propState.itemsAdjust - 1) : -1);

    function expandDateIndex(idx, array, dir) {
      // no need to adjust gibberish indices
      if (idx < 0 || idx >= array.length)
        return idx;
      var thresh = $date.quantizeDate(array[idx].headerInfo.date +
                                      (dir === -1 ? 0 : $date.DAY_MILLIS));
      var i;
      if (dir === -1) {
        for (i = idx - 1; i >= 0; i--) {
          if ($date.STRICTLY_AFTER(array[idx].headerInfo.date, thresh))
            break;
        }
        return i + 1;
      }
      else {
        for (i = idx + 1; i < array.length; i++) {
          if ($date.ON_OR_BEFORE(array[idx].headerInfo.date, thresh))
            break;
        }
        return i - 1;
      }
    }
    /**
     * Translate a known messages index to a server index.  For non-deleted
     * messages, straight-up indexOf works.  For deleted messages, we must
     * leverage the `serverDeleted` changelog.
     */
    function findServerIndex(knownIndex, shrinkAttr, expandDir) {
      if (!serverMessages.length ||
          knownIndex < -1)
        return 0;

      // If this is the earliest message known to us, then the time heuristics
      // in sync will clamp the search range to 'now', so we should be using
      // the first available server message too.  We intentionally do want to
      // do this prior to calling expandDateIndex.
      if (knownIndex === 0 && expandDir === -1)
        return 0;

      if (expandDir)
        knownIndex = expandDateIndex(knownIndex, knownMessages, expandDir);

      var header = knownMessages[knownIndex],
          srvIdx = serverMessages.indexOf(header);

      // -- Handle deletions
      while (srvIdx === -1) {
        var delIdx = serverDeleted.indexOf(header);
        if (delIdx === -1)
          throw new Error('Unable to sync up server/deleted index: ' +
                          JSON.stringify(header));

        header = serverDeleted[delIdx + 1][shrinkAttr];
        serverDeleted.splice(delIdx, 2);

        if (++seenDeleted > delCount)
          throw new Error('more deleted messages than expected!');
        knownMessages.splice(knownIndex, 1);
        knownIndex = knownMessages.indexOf(header);

        srvIdx = serverMessages.indexOf(header);
      }
      if (expandDir)
        srvIdx = expandDateIndex(srvIdx, serverMessages, expandDir);
      return srvIdx;
    }
    /**
     * 2-phase merge logic: 1) handle deltas for where knownMessages already
     * covers some of the messages, and 2) just chuck in the unknown up to the
     * limit once we run out of what knownMessages covers.
     *
     * Because our growth logic simplifies things by keeping refresh separate
     * from growth, only 1 of the 2 phases should actually come into play.
     *
     * @args[
     *   @param[srvLowIdx Number]{
     *     Low inclusive index.
     *   }
     *   @param[srvHighIdx Number]{
     *     High inclusive index.  Use srvLowIdx - 1 to cause instant
     *     termination.
     *   }
     * ]
     */
    function mergeIn(useLowIdx, useHighIdx, srvLowIdx, srvHighIdx) {
      var srvIdx, endSrvIdx,
          knownIdx, endKnownIdx, step,
          addOffset, addStep, addEndAdjust, delStep, delEndAdjust;
      switch(dir) {
        case 1:
        case 0:
          srvIdx = srvLowIdx;
          endSrvIdx = srvHighIdx + 1;
          knownIdx = useLowIdx;
          endKnownIdx = useHighIdx + 1;
          step = 1;
          break;
        case -1:
          srvIdx = srvHighIdx;
          endSrvIdx = srvLowIdx - 1;
          knownIdx = useHighIdx;
          endKnownIdx = useLowIdx - 1;
          step = -1;
          break;
      }
      //console.log('MERGE BEGIN', srvLowIdx, srvHighIdx,
      //            'srv', srvIdx, endSrvIdx, 'known', knownIdx, endKnownIdx);

      // -- phase 1: delta merge
      // Check the headers in both places, if they don't match, it must either
      // be a deletion or an addition.  Since we explicitly track deletions in
      // serverDeleted, we don't need to do any clever diff delta work; we just
      // look in there.
      while (srvIdx !== endSrvIdx &&
             knownIdx !== endKnownIdx &&
             (seenDeleted < delCount ||
              seenAdded < addCount)) {
        var knownHeader = knownMessages[knownIdx],
            serverHeader = serverMessages[srvIdx];
        if (knownHeader !== serverHeader) {
          var idxDeleted = serverDeleted.indexOf(knownHeader);
          // - added
          if (idxDeleted === -1) {
            seenAdded++;
            srvIdx += step;
            //console.log('MERGE add', knownIdx, serverHeader.headerInfo.subject);
            if (dir !== -1) {
              // Add at our current site, displacing the considered header to be
              // be the next header after a normal step.
              knownMessages.splice(knownIdx, 0, serverHeader);
              endKnownIdx++;
              knownIdx++;
            }
            else {
              // add the message 'behind' us and do not step; end stays in place
              knownMessages.splice(knownIdx + 1, 0, serverHeader);
            }
          }
          // - deleted
          else {
            //console.log('MERGE del', knownIdx);
            seenDeleted++;
            serverDeleted.splice(idxDeleted, 2);
            knownMessages.splice(knownIdx, 1);
            if (dir !== -1) {
              // if we splice something out, the next thing comes to us; no step
              // if we delete something; our end index comes down to meet us
              endKnownIdx--;
            }
            else {
              // if we splice something else, we still need to step
              knownIdx--;
              // if we delete something; our end index is still in the same spot
            }
          }
        }
        else {
          //console.log('MERGE same', knownIdx);
          srvIdx += step;
          knownIdx += step;
        }
      }

      // -- phase 2: cram leftovers
      // At this point, knownIdx points at the insertion point and (addCount -
      // seenAdded) is the number of messages to splice there.
      if (srvIdx !== endSrvIdx &&
           seenAdded < addCount) {
        var toAdd = addCount - seenAdded;
        //console.log('CRAM add:', toAdd, 'srv', srvIdx, endSrvIdx, 'at known', knownIdx);
        if (dir !== -1) {
          knownMessages.splice.apply(knownMessages,
            [knownIdx, 0].concat(serverMessages.slice(srvIdx, srvIdx + toAdd)));
        }
        else {
          knownMessages.splice.apply(knownMessages,
            [knownIdx, 0].concat(serverMessages.slice(srvIdx - toAdd + 1,
                                                      srvIdx + 1)));
        }
      }
    }


    // --- open
    if (dir === null) {
      // - initial sync
      if (!testFolder.initialSynced) {
        //console.log('initial');
        // The add count should exactly cover what we find out about; no need
        // to do anything with dates.
        dir = 1;
        mergeIn(
          knownMessages.length,
          lowKnownIdx - 1,
          knownMessages.length,
          knownMessages.length + addCount);
      }
      // - db already knows stuff
      // This is a refresh on top of a fetch of INITIAL_FILL_SIZE from the db.
      // reportCount is not the right thing to use because it tells us how
      // many messages we'll hear about after the refresh is all done.
      //
      // If this is a refresh that takes multiple passes, then the 0th will have
      // been the bisection abort that did nothing.  The 1st will be the one
      // that actually decides the server range we are processing, and
      // everything after that will just be the incremental steps.
      else if (propState.idx === 0) {
        var useCount = Math.min(knownMessages.length, $sync.INITIAL_FILL_SIZE);
        dir = 0;
        propState.highKnownHeader = knownMessages[useCount - 1];
        mergeIn(
          0,
          useCount - 1,
          (propState.serverLow = findServerIndex(0, 'above', -1)),
          (propState.serverHigh = findServerIndex(useCount - 1, 'below', 1)));
      }
      else {
        dir = 0;
        mergeIn(
          0,
          knownMessages.indexOf(propState.highKnownHeader),
          propState.serverLow,
          propState.serverHigh);
      }
    }
    // --- refresh
    else if (dir === 0) {
      mergeIn(
        lowKnownIdx,
        highKnownIdx,
        findServerIndex(lowKnownIdx, 'above', -1),
        findServerIndex(highKnownIdx, 'below', 1));
    }
    // --- growth to newer
    else if (dir === -1) {
      mergeIn(
        0, lowKnownIdx - 1,
        0, findServerIndex(lowKnownIdx, 'above', 1) - 1);
    }
    // --- growth to older
    else if (dir === 1) {
      mergeIn(
        highKnownIdx + 1,
        knownMessages.length - 1,
        findServerIndex(highKnownIdx, 'below', -1) + 1,
        serverMessages.length - 1);
    }

    return propState;
  },

  _expect_dateSyncs: function(viewThing, expectedValues, extraFlags,
                              syncDir) {
    var testFolder = viewThing.testFolder;
    this.RT.reportActiveActorThisStep(this.eImapAccount);
    this.RT.reportActiveActorThisStep(testFolder.connActor);
    var totalMessageCount = 0,
        nonet = checkFlagDefault(extraFlags, 'nonet', false);

    if (expectedValues) {
      if (!Array.isArray(expectedValues))
        expectedValues = [expectedValues];

      var propState = null;
      for (var i = 0; i < expectedValues.length; i++) {
        var einfo = expectedValues[i];
        totalMessageCount += einfo.count;
        if (this.universe.online && !nonet) {
          propState = this._propagateToKnownMessages(
            viewThing, propState,
            einfo.count, einfo.full, einfo.deleted, syncDir);

          if (!einfo.hasOwnProperty('startTS')) {
            testFolder.connActor.expect_syncDateRange_begin(null, null, null);
            testFolder.connActor.expect_syncDateRange_end(
              einfo.full, einfo.flags, einfo.deleted);
          }
          // some tests explicitly specify the date-stamps
          else {
            testFolder.connActor.expect_syncDateRange_begin(
              null, null, null, einfo.startTS, einfo.endTS);
            testFolder.connActor.expect_syncDateRange_end(
              einfo.full, einfo.flags, einfo.deleted,
              einfo.startTS, einfo.endTS);
          }
        }
      }
    }
    if (this.universe.online && !nonet) {
      testFolder.initialSynced = true;

      if (!checkFlagDefault(extraFlags, 'nosave', false))
        this.eImapAccount.expect_saveAccountState();
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
   *
   * @args[
   *   @param[extraFlags @dict[
   *     @key[expectFunc #:optional Function]{
   *       A function to invoke inside our action step after we have expected
   *       the mutexed call (without enabling set matching), but before doing
   *       anything else.
   *     }
   *     @key[nosave #:default false Boolean]{
   *       Used by _expect_dateSyncs to determine whether a call to
   *       expect_saveAccountState should be issued when we are in the online
   *       state.
   *     }
   *     @key[failure #:default false Boolean]{
   *       If true, indicates that we should expect a 'syncfailed' result.
   *     }
   *     @key[nonet #:default false Boolean]{
   *       Indicate that no network traffic is expected.  This is only relevant
   *       if we think we are online.
   *     }
   *     @key[syncedToDawnOfTime #:optional Boolean]{
   *       Assert that we are synced to the dawn of time at the end of this
   *       sync IFF this is known to be a PASTWARDS-sync.  We've recently
   *       changed the direction of refreshes to be FUTUREWARDS, in which case
   *       this heuristic does not apply.  Rather than go change all the test
   *       cases and make it harder to toggle the heuristic, we are building
   *       the logic in here.
   *     }
   *   ]]
   * ]
   */
  do_viewFolder: function(desc, testFolder, expectedValues, expectedFlags,
                          extraFlags, _saveToThing) {
    var self = this,
        isFailure = checkFlagDefault(extraFlags, 'failure', false);
    var testStep = this.T.action(this, desc, testFolder, 'using',
                                 testFolder.connActor, function() {
      self._expect_storage_mutexed(testFolder, 'sync', extraFlags);
      if (extraFlags && extraFlags.expectFunc)
        extraFlags.expectFunc();

      if (self.universe.online) {
        self.RT.reportActiveActorThisStep(self.eImapAccount);
        // Turn on set matching since connection reuse and account saving are
        // not strongly ordered, nor do they need to be.
        self.eImapAccount.expectUseSetMatching();
        if (!isFailure &&
            !checkFlagDefault(extraFlags, 'nonet', false)) {
          self.expect_connection();
          if (!_saveToThing)
            self.eImapAccount.expect_releaseConnection();
          else
            self._unusedConnections--;
        }
      }

      // generate expectations for each date sync range
      var totalExpected = self._expect_dateSyncs(
                            _saveToThing ||
                              { testFolder: testFolder,
                                offset: 0, slice: null },
                            expectedValues, extraFlags, null);
      if (expectedValues) {
        // Generate overall count expectation and first and last message
        // expectations by subject.
        self.expect_messagesReported(totalExpected);
        if (totalExpected) {
          self.expect_messageSubjects(
            testFolder.knownMessages.slice(0, totalExpected)
              .map(function(x) { return x.headerInfo.subject; }));
        }
        self.expect_sliceFlags(
          expectedFlags.top, expectedFlags.bottom,
          expectedFlags.growUp || false, expectedFlags.grow,
          isFailure ? 'syncfailed' : 'synced');
      }

      var slice = self.MailAPI.viewFolderMessages(testFolder.mailFolder);
      slice.oncomplete = function() {
        self._logger.messagesReported(slice.items.length);
        if (totalExpected) {
          self._logger.messageSubjects(
            slice.items.map(function(x) { return x.subject; }));
        }
        self._logger.sliceFlags(slice.atTop, slice.atBottom,
                                slice.userCanGrowUpwards,
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
    // (varies with N)
    testStep.timeoutMS = 1000 + 400 * testFolder._approxMessageCount;
    return testStep;
  },

  /**
   * @args[
   *   @param[viewThing]
   *   @param[dirMagnitude Number]
   *   @param[userRequestsGrowth Boolean]
   *   @param[alreadyExists Number]{
   *     How many messages should already be in the slice.
   *   }
   *   @param[expectedValues ExpectedValues]
   *   @param[extraFlags @dict[
   *     @see[do_viewFolder extraFlags]
   *     @key[willFail #:default false Boolean]{
   *       Do we expect the grow to fail?  This is used to indicate whether we
   *       expect the grow sync to return messages that the testhelper knows
   *       about or whetehr it expects an empoty result.
   *     }
   *   ]]
   * ]
   */
  do_growFolderView: function(viewThing, dirMagnitude, userRequestsGrowth,
                              alreadyExists, expectedValues, expectedFlags,
                              extraFlags) {
    var self = this;
    this.T.action(this, 'grows', viewThing, function() {
      var totalExpected;
      totalExpected = self._expect_dateSyncs(
                        viewThing, expectedValues, extraFlags,
                        dirMagnitude < 0 ? -1 : 1) +
                        alreadyExists;
      self.expect_messagesReported(totalExpected);

      self._expect_storage_mutexed(viewThing.testFolder, 'grow', extraFlags);

      var expectedMessages;
      if (dirMagnitude < 0) {
        viewThing.offset += dirMagnitude;
        expectedMessages = viewThing.testFolder.knownMessages.slice(
                             viewThing.offset,
                             viewThing.offset - dirMagnitude);
      }
      else {
        if (checkFlagDefault(extraFlags, 'willFail', false))
          expectedMessages = [];
        else
          expectedMessages = viewThing.testFolder.knownMessages.slice(
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
      var idxHighMessage = viewThing.offset + (useHigh - useLow);
      self.expect_messageSubjects(
        viewThing.testFolder.knownMessages
          .slice(viewThing.offset, idxHighMessage + 1)
          .map(function(x) {
                 return x.headerInfo.subject;
               }));
      self.expect_sliceFlags(expectedFlags.top, expectedFlags.bottom,
                             expectedFlags.growUp || false,
                             expectedFlags.grow, 'synced');


      viewThing.slice.onsplice = function(index, howMany, added,
                                          requested, moreExpected) {
        self._logger.splice(index, howMany);
      };
      viewThing.slice.oncomplete = function() {
        viewThing.slice.onsplice = null;

        self._logger.messagesReported(viewThing.slice.items.length);
        self._logger.messageSubjects(
          viewThing.slice.items.map(function(x) { return x.subject; }));
        self._logger.sliceFlags(
          viewThing.slice.atTop, viewThing.slice.atBottom,
          viewThing.slice.userCanGrowUpwards,
          viewThing.slice.userCanGrowDownwards,
          viewThing.slice.status);
      };

      viewThing.slice.requestShrinkage(useLow, useHigh);
    });
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

  getFirstFolderWithName: function(folderName) {
    return this.server.findFolderByName(folderName);
  },
};

var TestActiveSyncAccountMixins = {
  exactAttachmentSizes: true,
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
    if (opts.realAccountNeeded) {
      if (TEST_PARAMS_ARE_DEFAULTS)
        throw new Error('This test needs a real activesync account!');
      if (opts.realAccountNeeded === 'append')
        throw new Error(
          'This test will not work on real ActiveSync; need APPEND');
      self.testServer = null;
    }
    // If a server was not explicitly provided, then create one that should
    // have a lifetime of this current test step.  We use the blackboard
    // instead of the universe because a freshly started universe currently
    // does not know about the universe it is replacing.
    else if (!opts.server) {
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
    var step= self.T.convenienceSetup(self, 'creates test account', function() {
      self.__attachToLogger(LOGFAB.testAccount(self, null, self.__name));

      self.RT.reportActiveActorThisStep(self.eAccount);
      self.expect_accountCreated();
      self.expect_runOp('syncFolderList', { local: false, save: 'server' });

      self.universe = self.testUniverse.universe;
      self.MailAPI = self.testUniverse.MailAPI;

      self.MailAPI.tryToCreateAccount(
        {
          displayName:
            self._opts.realAccountNeeded ? TEST_PARAMS.name : 'test',
          emailAddress:
            self._opts.realAccountNeeded ? TEST_PARAMS.emailAddress
                                          : 'test@aslocalhost',
          password:
            self._opts.realAccountNeeded ? TEST_PARAMS.password : 'test',
          accountName: self._opts.name || null,
        },
        null,
        function accountMaybeCreated(error, errorDetails, account) {
          if (error) {
            self._logger.accountCreationError(error);
            return;
          }

          self.accountId = account.id;

          // Find the account instance in the MailUniverse (back-end) given the
          // wire rep of the account passed to us via our mailapi (front-end)
          // callback.
          for (var i = 0; i < self.universe.accounts.length; i++) {
            if (self.universe.accounts[i].id === account.id) {
              self.account = self.universe.accounts[i];
              break;
            }
          }

          if (!self.account)
            do_throw('Unable to find account for ' + TEST_PARAMS.emailAddress +
                     ' (id: ' + self.accountId + ')');

          // Because folder list synchronizing happens as an operation, we want
          // to wait for that operation to complete before declaring the account
          // created.
          self.universe.waitForAccountOps(self.account, function() {
            self._logger.accountCreated();
          });
        });
    });
    if (self._opts.realAccountNeeded)
      step.timeoutMS = 10000;
  },

  expect_shutdown: function() {
    this.RT.reportActiveActorThisStep(this.eAccount);
    this.eAccount.expectOnly__die();
  },

  expect_saveState: function() {
    this.RT.reportActiveActorThisStep(this.eAccount);
    this.eAccount.expect_saveAccountState();
  },

  _expect_restore: function() {
    this.RT.reportActiveActorThisStep(this.eAccount);
  },

  do_createTestFolder: function(folderName, messageSetDef) {
    var self = this,
        testFolder = this.T.thing('testFolder', folderName);
    testFolder.connActor = this.T.actor('ActiveSyncFolderConn', folderName);
    testFolder.storageActor = this.T.actor('FolderStorage', folderName);

    this.T.convenienceSetup(this, 'create test folder', testFolder, function() {
      self.expect_foundFolder(true);
      testFolder.serverFolder = self.testServer.server.addFolder(
        folderName, null, null, messageSetDef);
      testFolder.serverMessages = testFolder.serverFolder.messages;
      self.expect_runOp('syncFolderList', { local: false, save: 'server' });
      self.universe.syncFolderList(self.account, function() {
        self.MailAPI.ping(function() {
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

  do_useExistingFolder: function(folderName, suffix, oldFolder) {
    var self = this,
        testFolder = this.T.thing('testFolder', folderName + suffix);
    testFolder.connActor = this.T.actor('ActiveSyncFolderConn', folderName);
    testFolder.storageActor = this.T.actor('FolderStorage', folderName);
    testFolder._approxMessageCount = 30;

    this.T.convenienceSetup('find test folder', testFolder, function() {
      if (self.testServer) {
        testFolder.serverFolder = self.testServer.getFirstFolderWithName(
                                    folderName);
        testFolder.serverMessages = testFolder.serverFolder.messages;
      }
      testFolder.mailFolder =
        self.testUniverse.allFoldersSlice.getFirstFolderWithName(folderName);
      testFolder.id = testFolder.mailFolder.id;
      if (oldFolder) {
        testFolder.knownMessages = oldFolder.knownMessages;
        testFolder.serverDeleted = oldFolder.serverDeleted;
        testFolder.initialSynced = oldFolder.initialSynced;
      }

      testFolder.connActor.__attachToLogger(
        self.testUniverse.__folderConnLoggerSoup[testFolder.id]);
      testFolder.storageActor.__attachToLogger(
        self.testUniverse.__folderStorageLoggerSoup[testFolder.id]);
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
    testFolder._approxMessageCount = 30;

    this.T.convenienceSetup(this, 'find test folder', testFolder, function() {
      if (self.testServer) {
        testFolder.serverFolder = self.testServer.getFirstFolderWithType(
                                    folderType);
        testFolder.serverMessages = testFolder.serverFolder.messages;
      }
      testFolder.mailFolder =
        self.testUniverse.allFoldersSlice.getFirstFolderWithType(folderType);
      testFolder.id = testFolder.mailFolder.id;
      if (oldFolder) {
        testFolder.knownMessages = oldFolder.knownMessages;
        testFolder.serverDeleted = oldFolder.serverDeleted;
        testFolder.initialSynced = oldFolder.initialSynced;
      }

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
                          extraFlags, _saveToThing) {
    var self = this,
        isFailure = checkFlagDefault(extraFlags, 'failure', false);
    var testStep =
      this.T.action(this, desc, testFolder, 'using', testFolder.connActor,
                  function() {
      var totalExpected = self._expect_dateSyncs(
                            _saveToThing ||
                              { testFolder: testFolder,
                                offset: 0, slice: null },
                            expectedValues, extraFlags, 1);
      if (expectedValues) {
        self.expect_messagesReported(totalExpected);
        // Generate overall count expectation and first and last message
        // expectations by subject.
        if (totalExpected) {
          self.expect_messageSubjects(
            testFolder.knownMessages.slice(0, totalExpected)
              .map(function(x) { return x.subject; }));
        }
        self.expect_sliceFlags(
          expectedFlags.top, expectedFlags.bottom,
          expectedFlags.growUp || false, expectedFlags.grow,
          isFailure ? 'syncfailed' : 'synced');
      }

      var slice = self.MailAPI.viewFolderMessages(testFolder.mailFolder);
      slice.oncomplete = function() {
        self._logger.messagesReported(slice.items.length);
        if (totalExpected) {
          self._logger.messageSubjects(
            slice.items.map(function(x) { return x.subject; }));
        }
        self._logger.sliceFlags(slice.atTop, slice.atBottom,
                                slice.userCanGrowUpwards,
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
    testStep.timeoutMS = 1000 + 400 * testFolder._approxMessageCount;
    return testStep;
  },

  _expect_dateSyncs: function(viewThing, expectedValues, extraFlags,
                              syncDir) {
    var testFolder = viewThing.testFolder;
    this.RT.reportActiveActorThisStep(this.eAccount);
    this.RT.reportActiveActorThisStep(testFolder.connActor);

    var totalMessageCount = 0;
    if (expectedValues) {
      if (!Array.isArray(expectedValues))
        expectedValues = [expectedValues];

      for (var i = 0; i < expectedValues.length; i++) {
        var einfo = expectedValues[i];
        totalMessageCount += einfo.count;
        if (this.universe.online) {
          // The client should know about all of the messages on the server
          // after a sync.  If we start modeling the server only telling us
          // things in chunks, we will want to do something more clever here,
          // a la _propagateToKnownMessages
          testFolder.knownMessages = testFolder.serverMessages.concat();

          testFolder.connActor.expect_sync_begin(null, null, null);
          // TODO: have filterType and recreateFolder be specified in extraFlags
          // for consistency with IMAP.
          if (einfo.filterType)
            testFolder.connActor.expect_inferFilterType(einfo.filterType);
          if (einfo.recreateFolder) {
            this.eAccount.expect_recreateFolder(testFolder.id);
            this.eAccount.expect_saveAccountState();

            var oldConnActor = testFolder.connActor;
            oldConnActor.expect_sync_end(null, null, null);

            // Give the new actor a good name.
            var existingActorMatch =
                  /^([^#]+)(?:#(\d+))?$/.exec(oldConnActor.__name),
                newActorName;
            if (existingActorMatch[2])
              newActorName = existingActorMatch[1] + '#' +
                               (parseInt(existingActorMatch[2], 10) + 1);
            else
              newActorName = existingActorMatch[1] + '#2';
            // Because only one actor will be created in this process, we don't
            // need to reach into the 'soup' to establish the link and the test
            // infrastructure will do it automatically for us.
            var newConnActor = this.T.actor('ActiveSyncFolderConn',
                                            newActorName),
                newStorageActor = this.T.actor('FolderStorage', newActorName);
            this.RT.reportActiveActorThisStep(newConnActor);
            this.RT.reportActiveActorThisStep(newStorageActor);

            newConnActor.expect_sync_begin(null, null, null);
            newConnActor.expect_sync_end(
              einfo.full, einfo.flags, einfo.deleted);

            testFolder.connActor = newConnActor;
            testFolder.storageActor = newStorageActor;
          }
          else {
            testFolder.connActor.expect_sync_end(
              einfo.full, einfo.flags, einfo.deleted);
          }
        }
      }
    }
    if (this.universe.online &&
        !checkFlagDefault(extraFlags, 'nosave', false)) {
      this.eAccount.expect_saveAccountState();
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
      sliceFlags: { top: true, bottom: true, growUp: true, growDown: true,
                    status: true },
      messagesReported: { count: true },
      messageSubject: { index: true, subject: true },
      messageSubjects: { subjects: true },

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
    $imapacct.LOGFAB, $imapfolder.LOGFAB, $imapjobs.LOGFAB,
    $imapjs.LOGFAB,
    // SMTP!
    $smtpacct.LOGFAB,
    // ActiveSync!
    $activesyncacct.LOGFAB, $activesyncfolder.LOGFAB, $activesyncjobs.LOGFAB,
  ],
  actorMixins: {
    testUniverse: TestUniverseMixins,
    testAccount: TestCommonAccountMixins,
    testActiveSyncServer: TestActiveSyncServerMixins,
  },
  thingMixins: {
    testFolder: TestFolderMixins,
  },
};

});

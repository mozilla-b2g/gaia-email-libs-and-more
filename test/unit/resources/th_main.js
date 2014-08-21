define(function(require, exports, $module) {

var $log = require('rdcommon/log'),
    $allback = require('allback'),
    $mailuniverse = require('mailuniverse'),
    $mailbridge = require('mailbridge'),
    $maildb = require('maildb'),
    $mailapi = require('mailapi'),
    $slog = require('slog'),
    $date = require('date'),
    $accountcommon = require('accountcommon'),
    $imapacct = require('imap/account'),
    $pop3acct = require('pop3/account'),
    $pop3sync = require('pop3/sync'),
    $activesyncacct = require('activesync/account'),
    $activesyncfolder = require('activesync/folder'),
    $activesyncjobs = require('activesync/jobs'),
    $msggen = require('tests/resources/messageGenerator'),
    $mailslice = require('mailslice'),
    $cronsync = require('cronsync'),
    $searchfilter = require('searchfilter'),
    $sync = require('syncbase'),
    $imapfolder = require('imap/folder'),
    $imapjobs = require('imap/jobs'),
    $pop3jobs = require('pop3/jobs'),
    $util = require('util'),
    $errbackoff = require('errbackoff'),
    $smtpacct = require('smtp/account'),
    $router = require('worker-router'),
    $th_fake_imap_server = require('tests/resources/th_fake_imap_server'),
    $th_fake_pop3_server = require('tests/resources/th_fake_pop3_server'),
    $th_real_imap_server = require('tests/resources/th_real_imap_server'),
    $th_fake_as_server = require('tests/resources/th_fake_activesync_server');

function checkFlagDefault(flags, flag, def) {
  if (!flags || !flags.hasOwnProperty(flag))
    return def;
  return flags[flag];
}

function wrapConsole(type, logFunc) {
  return function() {
    var msg = '';
    for (var i = 0; i < arguments.length; i++) {
      if (msg)
        msg += ' ';
      msg += arguments[i];
    }
    logFunc(msg);
    window.originalConsole[type].apply(window.originalConsole, arguments);
  };
}
function makeConsoleForLogger(logger) {
  if (!window.originalConsole) {
    window.originalConsole = window.console;
  }
  window.console = {
    set _enabled(val) {
      window.originalConsole._enabled = val;
    },
    get _enabled() {
      return window.originalConsole._enabled;
    },
    log:   wrapConsole('log', logger.log.bind(logger)),
    error: wrapConsole('error', logger.error.bind(logger)),
    info:  wrapConsole('info', logger.info.bind(logger)),
    warn:  wrapConsole('warn', logger.warn.bind(logger)),
    trace: function() {
      console.error.apply(null, arguments);
      try {
        throw new Error('getting stack...');
      }
      catch (ex) {
        console.warn('STACK!\n' + ex.stack);
      }
    },
  };
}

exports.thunkConsoleForNonTestUniverse = function() {
  var consoleLogger = LOGFAB.console(null, null, 'console');
  makeConsoleForLogger(consoleLogger);
};

/**
 * Temporarily clobber a method on a prototype, invoking your provided callback
 * when the function is invoked.  Your function will be invoked with a function
 * you can use to release the call.  The intercept will immediately be removed
 * since this is a fairly dangerous game to be playing.
 *
 * @param {String} params.method
 * @param {Object} params.onProtoFromConstructor
 * @param {Function} params.callMyFunc
 * @param {Number} [params.skipCount=0]
 *   How many calls should we ignore before intercepting?  Use this when POP3
 *   or ActiveSync ruin your day.
 */
function interceptNextCall(params) {
  var methodName = params.method;
  var proto = params.onProtoFromConstructor.prototype;
  var callback = params.callMyFunc;
  var skipCount = params.skipCount || 0;

  var origFunc = proto[params.method];
  var replacementFunc = proto[params.method] = function() {
    var calledInst = this;
    var calledArgs = arguments;
    var releaseTheCall = function() {
      origFunc.apply(calledInst, calledArgs);
    };
    // If we should be skipping, immediately release/pass-through
    if (skipCount--) {
      try {
        releaseTheCall();
      }
      catch(ex) {
        console.error('Immediately released func threw:', ex);
      }
      return;
    }

    var curFunc = proto[methodName];
    if (curFunc !== replacementFunc) {
      console.warning('Intercepted func has been double intercepted?!',
                      methodName);
      throw new Error('Double-intercepted func: ' + methodName);
    }
    proto[methodName] = origFunc;
    // We are fine with this method throwing an exception, probably.
    callback(releaseTheCall);
  };
}

var TestUniverseMixins = {
  __constructor: function(self, opts) {
    self.eUniverse = self.T.actor('MailUniverse', self.__name, null, self);
    self.eCronSync = self.T.actor('CronSync', self.__name, null,
                                  self.eUniverse);

    // no need to keep creating consoles if one already got created...
    if (!opts || !opts.old) {
      var consoleLogger = LOGFAB.console(null, null, self.__name);
      makeConsoleForLogger(consoleLogger);
    }

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
    if (!checkFlagDefault(opts, 'realDate', false)) {
      self._useDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      // use local noon.
      self._useDate.setHours(12, 0, 0, 0);
      $date.TEST_LetsDoTheTimewarpAgain(self._useDate);
    }
    else {
      self._useDate = null;
      $date.TEST_LetsDoTheTimewarpAgain(null);
    }

    // We save/reuse our generator so that the subject numbers don't reset.  It
    // was very confusing when we would add a new message with a duplicate
    // subject.
    self.messageGenerator = new $msggen.MessageGenerator(self._useDate);

    if (!checkFlagDefault(opts, 'stockDefaults', false)) {
      // These are all the default values that tests code against by default.
      // If a test wants to use different values,
      $sync.TEST_adjustSyncValues({
        fillSize: 15,
        days: 7,
        growDays: 7,
        scaleFactor: 1.6,

        STALE_CONNECTION_TIMEOUT_MS: 60000, // arbitrarily large value for tests
        // Don't kill jobless connections, as most of the tests don't expect
        // the connections to die, and we test this independently within
        // test_imap_kill_unused_connections.js.
        KILL_CONNECTIONS_WHEN_JOBLESS: false,

        // Don't trigger the whole-folder sync logic except when we explicitly
        // want to test it.
        SYNC_WHOLE_FOLDER_AT_N_MESSAGES: 0,
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
    self.T.convenienceSetup(self, 'initializes', self.eUniverse, self.eCronSync,
                            function() {
      self.__attachToLogger(LOGFAB.testUniverse(self, null, self.__name));
      self._bridgeLog = LOGFAB.bridgeSnoop(self, self._logger, self.__name);

      self.RT.captureAllLoggersByType(
        'ImapFolderConn', self.__folderConnLoggerSoup);
      self.RT.captureAllLoggersByType(
        'ActiveSyncFolderConn', self.__folderConnLoggerSoup);
      self.RT.captureAllLoggersByType(
        'Pop3FolderSyncer', self.__folderConnLoggerSoup);
      self.RT.captureAllLoggersByType(
        'FolderStorage', self.__folderStorageLoggerSoup);

      self.fakeNavigator = opts.old ? opts.old.fakeNavigator : {
        onLine: true
      };

      // Propagate the old universe's message generator so that the subject
      // numbers don't get reset.
      if (opts && opts.old && opts.old.messageGenerator)
        self.messageGenerator = opts.old.messageGenerator;

      var restored = !!opts.old || opts.restored ||
                     !!self.__restoredAccounts.length;
      if (restored && !opts.nukeDb) {
        if (opts.upgrade) {
          self.eUniverse.expect_configMigrating_begin();
        }
        for (var iAcct = 0; iAcct < self.__restoredAccounts.length; iAcct++) {
          if (opts.upgrade) {
            self.eUniverse.expect_recreateAccount_begin();
          }
          var testAccount = self.__restoredAccounts[iAcct];
          testAccount._expect_restore();
        }
        // All the ends have to happen in a subsequent turn of the event loop
        // whereas the begins will happen right in a row.
        for (var iAcct = 0; iAcct < self.__restoredAccounts.length; iAcct++) {
          if (opts.upgrade) {
            self.eUniverse.expect_recreateAccount_end();
          }
          testAccount = self.__restoredAccounts[iAcct];
          if (opts.upgrade && opts.upgrade !== 'nowait' &&
              self.fakeNavigator.onLine) {
            testAccount.expect_runOp(
              'syncFolderList',
              { local: false, server: true, save: 'server' });
          }
        }
        if (opts.upgrade) {
          self.eUniverse.expect_configMigrating_end();
        }
        else {
          self.eUniverse.expect_configLoaded();
        }
      }
      else {
        self.eUniverse.expect_configCreated();
      }

      self.expect_createUniverse();

      self.expect_queriesIssued();
      var callbacks = $allback.allbackMaker(
        ['accounts', 'folders'],
        function gotSlices() {
          self._logger.queriesIssued();
        });

      var testOpts = {
        fakeNavigator: self.fakeNavigator
      };
      if (opts.dbDelta)
        testOpts.dbDelta = opts.dbDelta;
      if (opts.dbVersion)
        testOpts.dbVersion = opts.dbVersion;
      if (opts.nukeDb)
        testOpts.nukeDb = opts.nukeDb;

      self._sendHelperMessage = $router.registerCallbackType('testhelper');
      self._mainThreadMailBridge = false;

      // We always ensureSync at startup, wait for that or it could interfere
      // with cronsync tests.  (Also, we don't want this stuff smearing into
      // other test steps either.)
      self.eCronSync.expect_ensureSync_begin();
      self.eCronSync.expect_ensureSync_end();

      MailUniverse = self.universe = new $mailuniverse.MailUniverse(
        function onUniverse() {
          console.log('Universe created');
          var TMB = MailBridge = self._mailBridge =
                new $mailbridge.MailBridge(self.universe, self.__name);
          var TMA = MailAPI = self.MailAPI = new $mailapi.MailAPI();

          var realSendMessage = $router.registerSimple(
            'bridge',
            function(data) {
              TMB.__receiveMessage(data.args);
            });
          var bouncedSendMessage = $router.registerSimple(
            'bounced-bridge',
            function(msg) {
              // we duplicate the logic of __bridgeReceive here a little to
              // figure out whether this is a deferral or not.  If it is a
              // deferral, we log it as such.  We log processing by decorating
              // MailAPI._processMessage.
              if (TMA._processingMessage && msg.type !== 'pong') {
                self._bridgeLog.apiDefer(msg.type, msg);
              }
              TMA.__bridgeReceive(msg.args);
            });

          var origProcessMessage = TMA._processMessage;
          TMA._processMessage = function(msg) {
            self._bridgeLog.apiProcess(msg.type, msg);
            origProcessMessage.call(TMA, msg);
          };

          TMA.__bridgeSend = function(msg) {
            self._bridgeLog.apiSend(msg.type, msg);
            // 'bridge' => main => 'bounced-bridge'
            bouncedSendMessage(null, msg);
          };
          TMB.__sendMessage = function(msg) {
            self._bridgeLog.bridgeSend(msg.type, msg);
            // 'bounced-bridge' => main => 'bridge'
            realSendMessage(null, msg);
          };
          self._logger.createUniverse();


          gAllAccountsSlice = self.allAccountsSlice =
            self.MailAPI.viewAccounts(false);
          gAllAccountsSlice.oncomplete = callbacks.accounts;

          gAllFoldersSlice = self.allFoldersSlice =
            self.MailAPI.viewFolders('navigation');
          gAllFoldersSlice.oncomplete = callbacks.folders;
        },
        self.fakeNavigator.onLine,
        testOpts);
    });
    self.T.convenienceDeferredCleanup(self, 'cleans up', self.eUniverse,
                                      function() {
      self.cleanShutdown();
    });
  },

  /**
   * Spin up a MailAPI instance on the main thread whose MailBridge instance
   * lives here (on the worker thread), and which relays the message via a
   * 'mail-bridge' router topic.  This is to allow for test code to run on the
   * main thread where WebAPIs are different than what a worker sees.
   *
   * This is different from our bounced bridge instantiated in
   * TestUniverseMixins.__constructor where we create a MailAPI here on the
   * worker and bridge the data to the main thread and back again just so we
   * can test structured cloning impact and simplify our unit tests by really
   * just running on one thread.
   */
  ensureMainThreadMailAPI: function() {
    if (this._mainThreadMailBridge)
      return;

    var bridge = this._mainThreadMailBridge =
          new $mailbridge.MailBridge(this.universe);
    var sendMessage = $router.registerSimple(
      'main-bridge',
      function(data) {
        bridge.__receiveMessage(data.args);
      });

    this._mainThreadMailBridge.__sendMessage = function(msg) {
      sendMessage('main-bridge', msg);
    }.bind(this);

    this._sendHelperMessage('create-mailapi');
  },

  do_timewarpNow: function(useAsNowTS, humanMsg) {
    if (!humanMsg)
      throw new Error('You need to provide a message! The humans like them!');
    var self = this;
    this.T.convenienceSetup(humanMsg, function() {
      self._useDate = useAsNowTS;

      // -- Timezone compensation horrors!
      // If we are using a real IMAP server like dovecot, then it will use its
      // INTERNALDATE logic regardless of what timezone we cram into the
      // message.  As such, we need to detect a daylight savings time delta
      // between our current offset and the IMAP server offset and apply a fixup
      // to our message generator.
      //
      // This is a stop-gap solution that currently only affects
      // test_imap_complex.js's "repeated refresh is stable" unit test which
      // cares about the edge case.  It needs to be using a fake IMAP server to
      // have the desired control.  We will predicate that test on using the
      // IMAP fake server.
      var thenTzOffset = new Date(useAsNowTS).getTimezoneOffset() * -60000;
      for (var i = 0; i < self.__testAccounts.length; i++) {
        var testAccount = self.__testAccounts[i];
        testAccount._useDate = useAsNowTS;
        if (testAccount._useDate &&
            testAccount.imapAccount &&
            testAccount.testServer.NEEDS_REL_TZ_OFFSET_ADJUSTMENT) {
          var nowTzOffset = testAccount.imapAccount.tzOffset;
          if (nowTzOffset !== thenTzOffset) {
            console.log('current offset', nowTzOffset, 'versus', thenTzOffset,
                        'adjusting useDate by', thenTzOffset - nowTzOffset);
            testAccount._useDate += (thenTzOffset - nowTzOffset);
          }
        }
        // tell the server about the date we're using
        testAccount.testServer.setDate(testAccount._useDate);
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
    this.T.action(self.eUniverse, 'save state', function() {
      self.eUniverse.expect_saveUniverseState_begin();
      for (var i = 0; i < self.__testAccounts.length; i++) {
        self.__testAccounts[i].expect_saveState();
      }
      self.eUniverse.expect_saveUniverseState_end();
      self.universe.saveUniverseState();
    });
  },

  cleanShutdown: function() {
    if (this.universe === null)
      return;

    for (var i = 0; i < this.__testAccounts.length; i++) {
      this.__testAccounts[i].expect_shutdown();
    }
    this.expect_cleanShutdown();

    this.universe.shutdown(function() {
      this._logger.cleanShutdown();
      this.universe = null;
    }.bind(this));
  },

  do_shutdown: function() {
    var self = this;
    this.T.convenienceSetup('shutdown', this, this.__testAccounts, function() {
      self.cleanShutdown();
    });
  },

  /**
   * Immediately change ourselves to be online/offline; call from within a
   * test step or use do_pretendToBeOffline that does it for you.
   */
  pretendToBeOffline: function(beOffline) {
    this.fakeNavigator.onLine = !beOffline;
    this.universe._onConnectionChange();
  },

  /**
   * Start/stop pretending to be offline.  In this case, pretending means that
   * we claim we are offline but do not tear down our IMAP connections.
   */
  do_pretendToBeOffline: function(beOffline, runBefore) {
    var self = this;
    var step = this.T.convenienceSetup(
      beOffline ? 'go offline' : 'go online',
      function() {
        if (runBefore)
          runBefore();
        self.pretendToBeOffline(beOffline);
      });
    // the step isn't boring if we add expectations to it.
    if (runBefore)
      step.log.boring(false);
  },

  do_setOutboxSyncEnabled: function(enabled) {
    this.T.convenienceSetup('setOutboxSyncEnabled = ' + enabled, function() {
      this.universe.setOutboxSyncEnabled(this.universe.accounts[0], enabled);
    }.bind(this));
  },

  /**
   * Issue range queries on the database, failing if rows are present in any
   * of the given
   */
  help_checkDatabaseDoesNotContain: function(tablesAndKeyPrefixes) {
    var self = this;

    tablesAndKeyPrefixes.forEach(function(checkArgs) {
      self.expect_dbRowPresent(checkArgs.table, checkArgs.prefix, false);
    });
    this._sendHelperMessage(
      'checkDatabaseDoesNotContain', tablesAndKeyPrefixes,
      function(results) {
        results.forEach(function(result) {
          if (result.errCode)
            self._logger.dbProblem(result.errCode);
          else
            self._logger.dbRowPresent(result.table, result.prefix,
                                      result.hasResult);
        });
      });
  },

  do_killQueuedOperations: function(testAccount, opsType, count, saveTo) {
    var self = this;
    this.T.action(this, 'kill operations for', testAccount, function() {
      self.expect_killedOperations(opsType, count);

      var ops = self.universe._opsByAccount[testAccount.accountId][opsType];
      var killed = ops.splice(0, ops.length);
      self._logger.killedOperations(opsType, killed.length, killed,
                                    ops);
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
        self.universe._queueAccountOp(testAccount.account, killedThing.ops[i]);
      }
      self.universe.waitForAccountOps(testAccount.account, function() {
        self._logger.operationsDone();
      });
    });
  },

  //////////////////////////////////////////////////////////////////////////////
  // cronsync helpers
  //
  // Assist in testing cronsync by letting us easily separate and control the
  // complex stuff going on under the hood.  We only go for the big-picture
  // life-cycle expectations here beause we trust more detailed/specific tests
  // to verify the nitty gritty of folder sync and outbox sending and such.
  // (Also, it would be a nightmare to integrate them into the chopped-up
  // stuff we're doing here.)

  /**
   * Trigger cronsync but gum up the works so we can control what's happening
   * so the interesting stuff happens in one or more independent test steps.
   *
   * Specifically, we grab mutexes on all the outboxes and inboxes for the
   * accounts you tell us about.  This will wedge the sync process with a
   * runMutexed call to MailSlice._sliceOpenMostRecent pending.  This will wedge
   * the outbox inside the do_sendOutboxMessages job-op in
   * JobDriver._accessFolderForMutation.  We generate appropriate expectations
   * and you must use do_cronsync_releaseAccountSync and
   * do_cronsync_releaseOutbox for each account to un-wedge them.  We wedge
   * both of them every time.
   *
   * We trigger the cronsync by directly poking its onAlarm method.  It has no
   * cleverness that would defeat this (at this time).
   *
   * @param {Object} opts
   * @param {TestAccount[]} accounts
   *   The test accounts you expect to participate in the cronsync.  We don't
   *   second-guess you, so don't screw up.
   * @param {Number} inboxHasNewMessages
   *   Do you expect the inbox to fetch new messages?  How many?
   * @param {Number} outboxHasMessages
   *   Do you expect the outbox to have messages?  How many?
   */
  do_cronsync_trigger: function(opts) {
    this._staticCronSyncOpts = opts;
    this.T.action('acquire folder mutexes for inboxes/outboxes', function() {
      // save off the opts for the final summary stuff
      this._cronSyncOpts = opts;
      opts.accounts.forEach(function(testAccount) {
        var state = testAccount._cronSyncState = {
          inboxHasNewMessages: opts.inboxHasNewMessages,
          // We always sync the inbox (when we're online, which we currently
          // assume is the case in these helpers), so whether we will find
          // messages or not does not matter.
          inboxPending: true,
          outboxHasMessages: opts.outboxHasMessages,
          outboxPending: !!opts.outboxHasMessages
        };

        this.RT.reportActiveActorThisStep(testAccount);
        testAccount.expect_mutexStolen('inbox');
        testAccount.expect_mutexStolen('outbox');

        var inboxMeta = testAccount.account.getFirstFolderWithType('inbox');
        var outboxMeta = testAccount.account.getFirstFolderWithType('outbox');

        var inboxStorage =
              this.universe.getFolderStorageForFolderId(inboxMeta.id);
        var outboxStorage =
              this.universe.getFolderStorageForFolderId(outboxMeta.id);

        inboxStorage.runMutexed('steal', function(callWhenDone) {
          testAccount._logger.mutexStolen('inbox');
          state.releaseInboxMutex = callWhenDone;
        });
        outboxStorage.runMutexed('steal', function(callWhenDone) {
          testAccount._logger.mutexStolen('outbox');
          state.releaseOutboxMutex = callWhenDone;
        });
      }.bind(this));
    }.bind(this));
    this.T.action(this, 'trigger cronsync', this.eCronSync, function() {
      // note: these each take one argument (which the logger expects)
      this.MailAPI.oncronsyncstart = function(accountIds) {
        this._logger.apiCronSyncStartReported(accountIds);
      }.bind(this);
      this.MailAPI.oncronsyncstop = function(accountsResults) {
        var summary;
        if (accountsResults.updates) {
          // summarize
          summary = accountsResults.updates.map(function(perAccountInfo) {
            return {
              id: perAccountInfo.id,
              count: perAccountInfo.count
              // TODO: maybe we want the message excerpt statistics too, or maybe
              // we just want to let the caller tell us/let the caller check.
            };
          });
        }
        // it's part of the de facto contract that updates is falsey if nothing
        // happened.
        else {
          summary = null;
        }
        this._logger.apiCronSyncStopReported(summary, accountsResults);
      }.bind(this);


      var accountIds = [];

      this.eCronSync.expect_alarmFired();
      this.eCronSync.expect_cronSync_begin();
      this.eCronSync.expect_ensureSync_begin();
      this.eCronSync.expect_syncAccounts_begin();
      opts.accounts.forEach(function(testAccount) {
        var accountId = testAccount.accountId;
        accountIds.push(accountId);

        this.eCronSync.expect_syncAccount_begin(accountId);
        this.eCronSync.expect_syncAccountHeaders_begin(accountId);
        if (opts.outboxHasMessages) {
          this.eCronSync.expect_sendOutbox_begin(accountId);
          // the job will also start but then get wedged waiting on our mutex
          this.RT.reportActiveActorThisStep(testAccount.eOpAccount);
          testAccount.eOpAccount.expect_runOp_begin(
            'do', 'sendOutboxMessages', null);
        }
      }.bind(this));
      this.eCronSync.expect_ensureSync_end();

      this.expect_apiCronSyncStartReported(accountIds);

      this.universe._cronSync.onAlarm(accountIds);
    }.bind(this));
  },

  /**
   * Release the inbox mutex so the sync can start happening.  The sync will
   * finish talking to the server, issue a save, wait for the save, and then
   * report its completion.
   *
   * We stall the save process by intercepting the call to
   * MailDB.saveAccountFolderStates so you can release it by calling
   * `do_cronsync_releaseSyncDatabaseSave`.
   */
  do_cronsync_releaseAccountSyncButStallSave: function(testAccount) {
    this.T.action(testAccount, 'release mutex/let sync happen/stall save',
                  function() {
      var state = testAccount._cronSyncState;
      this.RT.reportActiveActorThisStep(testAccount.eOpAccount);

      // IMAP should be establishing a new account every time.
      if (testAccount.eImapAccount) {
        testAccount.eImapAccount.expect_createConnection();
        // (it may seem weird, but we are "reusing" it after creating it...)
        testAccount.eImapAccount.expect_reuseConnection();
      }
      // POP3 doesn't actually have a choice.  New connections every time.
      else if (testAccount.ePop3Account) {
        testAccount.ePop3Account.expect_createConnection();
      }

      // POP3 does some batch commit stuff too iff there are messages
      var skipCount = 0;
      if (state.inboxHasNewMessages && testAccount.type === 'pop3') {
        // Avoid intercepting the call for this one.
        skipCount = 1;
        testAccount.eOpAccount.expect_saveAccountState_begin('syncBatch');
        testAccount.eOpAccount.expect_saveAccountState_end('syncBatch');
      }

      testAccount.expect_interceptedAccountSave();
      testAccount.eOpAccount.expect_saveAccountState_begin(
        testAccount.type !== 'pop3' ? 'checkpointSync' : 'syncComplete');

      interceptNextCall({
        method: 'saveAccountFolderStates',
        onProtoFromConstructor: $maildb.MailDB,
        skipCount: skipCount,
        callMyFunc: function(releaseFunc) {
          testAccount._logger.interceptedAccountSave();
          testAccount._cronsyncReleaseDBSave = releaseFunc;
        }.bind(this)
      });

      state.releaseInboxMutex();
      state.releaseInboxMutex = null;
    }.bind(this));
  },

  /**
   * We release the save related to the sync process itself, allowing the slice
   * to report completion, for cronsync to report syncAccount_end, and then for
   * it to either be done or to issue snippet downloads if there were any new
   * messages.
   *
   * If we're going to download snippets that looks like: snippetFetchAccount
   * logged, the job starts/ends, the job saves and we intercept that.  Because
   * we don't want yet another function related to releasing the sync (who
   * actually wants to interleave that?), we'll include the sync if relevant.
   */
  do_cronsync_releaseSyncDatabaseSave: function(testAccount, expectFunc) {
    var willDownloadSnippets = !!this._staticCronSyncOpts.inboxHasNewMessages;
    var desc;
    if (willDownloadSnippets) {
      desc = 'release sync save, download snippets, stall save';
    }
    else {
      desc = 'release sync save, sync completes';
    }
    this.T.action(testAccount, desc, this.eCronSync, function() {
      this.RT.reportActiveActorThisStep(testAccount.eOpAccount);

      var state = testAccount._cronSyncState;
      // we could be more precise about where we clear this, out tests are
      // granular enough that we can centralize this here.
      state.inboxPending = false;
      // We need snippets if there were messages, but POP3 downloads them as part
      // of the sync process.
      var willDownloadSnippets = !!state.inboxHasNewMessages &&
                                 testAccount.type !== 'pop3';

      testAccount.expect_releasedAccountSave();
      testAccount.eOpAccount.expect_saveAccountState_end(
        testAccount.type !== 'pop3' ? 'checkpointSync' : 'syncComplete');
      if (testAccount.eOpAccount.ignore_releaseConnection) {
        testAccount.eOpAccount.ignore_releaseConnection();
      }

      this.eCronSync.expect_syncAccountHeaders_end(testAccount.accountId);

      if (willDownloadSnippets) {
        // Since we're going on to download something, there will be a server
        // job and although the connection will be released, it will then be
        // immediately reused for the job.
        if (testAccount.eImapAccount) {
          testAccount.eImapAccount.expect_releaseConnection();
        }

        this.eCronSync.expect_syncAccountSnippets_begin(testAccount.accountId);
        testAccount.expect_runOp(
          'downloadBodies',
          {
            local: false, server: true, save: 'server',
            // IMAP:
            // There will be no "reuseConnection" log entry generated because we
            // make sure to kill the slice only after starting downloadBodies.
            // Specifically, the ImapFolderConn is still holding onto the
            // ImapConnection as long as the slice is alive and the
            // downloadBodies job-op is able to immediately be scheduled and
            // acquire the mutex and connection before the slice is killed.
            //
            // POP3:
            // POP3 has to establish a connection to do this since it closed the
            // connection as part of the sync process.  Let's pretend it's
            // impossible to do a better job.
            conn: testAccount.type === 'pop3',
            // However, we do expect a release
            release: true,
            // we will be interrupting the save
            interruptServerSave: true
          });

        testAccount.expect_interceptedAccountSave();
        interceptNextCall({
          method: 'saveAccountFolderStates',
          onProtoFromConstructor: $maildb.MailDB,
          callMyFunc: function(releaseFunc) {
            testAccount._logger.interceptedAccountSave();
            testAccount._cronsyncReleaseSnippetSave = releaseFunc;
          }.bind(this)
        });
      }
      else {
        this.eCronSync.expect_syncAccount_end(testAccount.accountId);

        // Since there are no snippets, we will release the connection.  If
        // there is no outbox job queued or it has already completed, we will
        // also end up killing the connection.
        if (testAccount.eImapAccount) {
          testAccount.eImapAccount.expect_releaseConnection();
          if (!state.outboxHasMessages || !state.releaseOutboxMutex) {
            testAccount.eImapAccount.expect_deadConnection('unused');
          }
          else {
            testAccount._unusedConnections++;
          }
        }

        if (expectFunc) {
          expectFunc();
        }
      }

      var releaseFunc = testAccount._cronsyncReleaseDBSave;
      testAccount._cronsyncReleaseDBSave = null;
      testAccount._logger.releasedAccountSave();
      releaseFunc();
    }.bind(this));
    // Bail if we don't have a snippet downloading step that we interfered with.
    // And yeah, I really want the test-refactor thing where we can maybe not
    // have quite this insanity.
    if (!this._staticCronSyncOpts.inboxHasNewMessages ||
        testAccount.type === 'pop3') {
      return;
    }
    this.T.action(testAccount, 'release snippet save', this.eCronSync, function(){
      testAccount.expect_releasedAccountSave();
      this.eCronSync.expect_syncAccountSnippets_end(testAccount.accountId);
      this.eCronSync.expect_syncAccount_end(testAccount.accountId);

      if (expectFunc) {
        expectFunc();
      }

      var releaseFunc = testAccount._cronsyncReleaseSnippetSave;
      testAccount._cronsyncReleaseSnippetSave = null;
      testAccount._logger.releasedAccountSave();
      releaseFunc();
    }.bind(this));
  },

  do_cronsync_releaseOutbox: function(testAccount, expectFunc) {
    this.T.action(testAccount, 'release mutex/let outbox send happen',
                  this.eCronSync, function() {
      var state = testAccount._cronSyncState;

      if (state.outboxHasMessages) {
        state.outboxPending = false;
        var inboxPending = state.inboxPending;

        // our wedging left the first job partway through its run process,
        // so we want to close that one out, then do full processings for all
        // subsequent ones
        this.RT.reportActiveActorThisStep(testAccount.eOpAccount);
        testAccount.eOpAccount.expect_runOp_end(
          'do', 'sendOutboxMessages', null);
        testAccount.eOpAccount.expect_saveAccountState_begin(
          'serverOp:sendOutboxMessages');
        testAccount.eOpAccount.expect_saveAccountState_end(
          'serverOp:sendOutboxMessages');
        // The append may need to create a new connection if the inbox sync
        // is still wedged.  (In fact, the inbox won't have created its
        // connection yet.  But the connection will get thrown away when
        // we're done because of how we're doing the wedging.  We don't care
        // about this much because in reality we absolutely expect the inbox
        // sync to start before an IMAP APPEND could ever start, let alone
        // finish, so our test cases cover reality quite well.)
        testAccount.expect_saveSentMessage(true);
        for (var iMsg = 1; iMsg < state.outboxHasMessages; iMsg++) {
          testAccount.expect_sendOutboxMessages();
          testAccount.expect_saveSentMessage(true);
        }

        if (testAccount.eImapAccount) {
          testAccount.eImapAccount.expect_deadConnection('unused');
          // By definition an unused reaping brings us to 0 unused.
          testAccount._unusedConnections = 0;
        }

        this.eCronSync.expect_sendOutbox_end(testAccount.accountId);
      }

      if (expectFunc) {
        expectFunc();
      }

      state.releaseOutboxMutex();
      state.releaseOutboxMutex = null;
    }.bind(this));
  },

  /**
   * Expect func to call for all the things that happen when cronsync completes.
   * This will occur when all the release functions above complete across all of
   * the accounts being synchronized.  You the test-writer are responsible for
   * passing this as an argument to the release function or calling it from
   * inside your own expectFunc that you pass to them, etc. etc.
   */
  expect_cronsync_completed: function() {
    var opts = this._cronSyncOpts;

    this.RT.reportActiveActorThisStep(this);
    this.RT.reportActiveActorThisStep(this.eCronSync);
    // (ensureSync_end was already expected during the triggering process)
    // there should be 0 active slices when we complete, so 0 should be killed.
    this.eCronSync.expect_killSlices(0);
    this.eCronSync.expect_syncAccounts_end();
    this.eCronSync.expect_cronSync_end();

    var expectedSummary = opts.accounts.map(function(testAccount) {
      return {
        id: testAccount.accountId,
        count: opts.inboxHasNewMessages
      };
    });

    this.expect_apiCronSyncStopReported(expectedSummary);
  },

  /**
   * Expect an ensureSync to occur, probably because an account def is getting
   * saved.
   */
  expect_ensureSync: function() {
    this.RT.reportActiveActorThisStep(this.eCronSync);
    this.eCronSync.expect_ensureSync_begin();
    this.eCronSync.expect_ensureSync_end();
  },

  //////////////////////////////////////////////////////////////////////////////
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

    var TEST_PARAMS = self.RT.envOptions;
    self.displayName = self._opts.displayName || TEST_PARAMS.name;
    self.emailAddress = self._opts.emailAddress || TEST_PARAMS.emailAddress;
    self.initialPassword = self._opts.password || TEST_PARAMS.password;

    self._useDate = self.testUniverse._useDate;

    self.type = TEST_PARAMS.type;
    // -- IMAP/POP3
    if (TEST_PARAMS.type === 'imap' ||
        TEST_PARAMS.type === 'pop3') {
        mix(TestCompositeAccountMixins, self);
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
   * Stuff to do across all account types, expectation setting phase.  For
   * stuff to do *after* the account has been created (AKA tryToCreateAccount
   * has been called), put it in/call _help_commonTestAccountConfig.
   *
   * We do/want to do:
   * - Have a per-account folders list.  allFoldersSlice turns out to be a foot
   *   gun for most purposes.
   */
  _expect_commonTestAccountConfig: function() {
    this.RT.reportActiveActorThisStep(this);
    this.expect_folderSlicePopulated();
  },

  _help_commonTestAccountConfig: function() {
    this.foldersSlice = this.MailAPI.viewFolders('account',
                                                 { id: this.accountId });
    this.foldersSlice.oncomplete = function() {
      this._logger.folderSlicePopulated();
    }.bind(this);
  },

  /**
   * Expect our account def to be saved and its side-effects to run to
   * completion.  This notably includes a call to ensureSync and an
   * account modification normalization.
   *
   * XXX we currently don't wait for the notification because in
   * do_modifyAccount we're already waiting in a way that entirely contains
   * that notification.
   */
  expect_saveAccountDef: function() {
    this.testUniverse.expect_ensureSync();
  },

  /**
   * Do you not give a fig about connections?  Then call me!  I get specialized
   * by the accounts to help you with your lack of fig-giving.
   *
   * NB: This was added for a good reason but then it turned out we gave a fig,
   * so it's currently unused.  But it could be needed again soon, so...
   */
  ignore_connectionStuff: function() {
  },

  /**
   * Modify the account, asserting that the modification completed.
   */
  do_modifyAccount: function(options) {
    this.T.action(this, 'modify account',
                  'with options', JSON.stringify(options), function() {
      this.expect_accountModified();
      this.expect_saveAccountDef();

      var acct = this.testUniverse.allAccountsSlice
                   .getAccountById(this.accountId);
      acct.modifyAccount(options, function() {
        this._logger.accountModified();
      }.bind(this));
    }.bind(this));
  },

  /**
   * Modify a particular identity, at index i in account.identities
   */
  do_modifyIdentity: function(i, options) {
    this.T.action(this, 'modify identity',
                  'with options', JSON.stringify(options), function() {
      this.expect_identityModified();
      this.expect_saveAccountDef();

      var acct = this.testUniverse.allAccountsSlice
            .getAccountById(this.accountId);
      var identity = acct.identities[i];
      identity.modifyIdentity(options, function() {
        this._logger.identityModified();
      }.bind(this));
    }.bind(this));
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
   *  @param[expectedFlags @dict[
   *    @key[top]
   *    @key[bottom]
   *    @key[growUp #:default false]
   *    @key[grow]
   *    @key[newCount #:optional]{
   *      The number of new messages we expect to be reported with the
   *      conclusion of this sync.  If omitted, no expectation is placed on this
   *      number.  'new' messages are messages that are newer than the most
   *      recent known message (as of the start of the sync) which are unread.
   *    }
   *  ]]
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
                                 completeCheckOn, extraFlags) {
    this.RT.reportActiveActorThisStep(this);

    var changeMap = {}, self = this,
        isFailure = checkFlagDefault(extraFlags, 'failure', false);
    // - generate expectations and populate changeMap
    var i, iExp, expAdditionRep = {}, expDeletionRep = {}, expChangeRep = {};
    if (expected.hasOwnProperty('additions') && expected.additions) {
      for (i = 0; i < expected.additions.length; i++) {
        var msgThing = expected.additions[i], subject;
        expAdditionRep[msgThing.subject] = true;
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
    if (expectedFlags) {
      var callArgs = [expectedFlags.top, expectedFlags.bottom,
                      expectedFlags.growUp || false,
                      expectedFlags.grow,
                      isFailure ? 'syncfailed' : 'synced'];
      if (expectedFlags.newCount !== undefined)
        callArgs.push(expectedFlags.newCount);
      this.expect_sliceFlags.apply(this, callArgs);
    }

    // - listen for the changes
    var additionRep = {}, changeRep = {}, deletionRep = {},
        eventCounter = 0;
    viewThing.slice.onadd = function(item) {
      additionRep[item.subject] = true;
      if (eventCounter && --eventCounter === 0)
        completed(null);
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
        completed(null);
    };
    viewThing.slice.onremove = function(item) {
      deletionRep[item.subject] = true;
      if (eventCounter && --eventCounter === 0)
        completed(null);
    };
    var completed = function completed(newEmailCount) {
      if (!completeCheckOn)
        self._logger.messagesReported(viewThing.slice.items.length);
      self._logger.changesReported(additionRep, changeRep, deletionRep);
      if (expectedFlags)
        self._logger.sliceFlags(viewThing.slice.atTop, viewThing.slice.atBottom,
                                viewThing.slice.userCanGrowUpwards,
                                viewThing.slice.userCanGrowDownwards,
                                viewThing.slice.status,
                                newEmailCount === undefined ?
                                  null : newEmailCount);

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
    // offset of the slice into testFolder.knownMessages
    viewThing.offset = 0;
    viewThing.initialSynced = false;
    this.do_viewFolder('opens', testFolder, expectedValues, expectedFlags,
                       extraFlags, viewThing);
    return viewThing;
  },

  /**
   * Expect the number of unread messaged in the folder to equal num
   */
  expect_unread: function(desc, testFolder, eSync, num) {
    eSync.expect_namedValue(desc + ' backend', num);
    eSync.expect_namedValue(desc + ' frontend', num);

    var backendUnread = this.universe
      .getFolderStorageForFolderId(testFolder.id).folderMeta.unreadCount;
    eSync.namedValue(desc + ' backend', backendUnread);
    eSync.namedValue(desc + ' frontend', testFolder.mailFolder.unread);
  },

  /**
   * Perform a one-shot viewing of the contents of the folder to see that we
   * get back the right thing.  Use do_openFolderView if you want to open it
   * and keep it open and detect changes, etc.
   *
   * @args[
   *   @param[expectedValues @listof[@dict[
   *     @key[count Number]{
   *       The number of messages that will be returned by the sync.
   *     }
   *     @key[full Number]{
   *       The number of new messages that will be retrieved.
   *     }
   *     @key[flags Number]{
   *       The number of IMAP flag updates that will be received.  This is not
   *       relevant for ActiveSync (see changed).  If we start doing fancier
   *       CONDSTORE/QRESYNC things for IMAP, this may not be relevant in those
   *       cases.
   *     }
   *     @key[changed Number]{
   *       The number of changed messages we will hear about.  Currently only
   *       relevant for ActiveSync.
   *     }
   *     @key[deleted Number]{
   *       The number of deletions we will hear about/infer.
   *     }
   *   ]]]{
   *     A dict should exist for each (date-range) sync that is a part of the
   *     over-arching sync associated with this request.  If there is only one
   *     dict, you don't need to wrap it in an array.  For ActiveSync, we
   *     always only perceive one sync.  For IMAP there can be multiple.
   *   }
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
   *     @key[failure #:default false @oneof[false true 'die']]{
   *       If true, indicates that we should expect a 'syncfailed' result and no
   *       connection expectations.  If 'deadconn', it means the connection will
   *       die during the sync.
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
        isFailure = checkFlagDefault(extraFlags, 'failure', false),
        syncblocked = checkFlagDefault(extraFlags, 'syncblocked', false);
    var testStep = this.T.action(this, desc, testFolder, 'using',
                                 testFolder.connActor, function() {
      self._expect_storage_mutexed(testFolder, 'sync', extraFlags);
      if (extraFlags && extraFlags.expectFunc)
        extraFlags.expectFunc();

      // XXX this connection stuff got really ugly with the introduction of POP3
      // POP3 always establishes a new connection every time; it has to.
      if (self.type === 'pop3' && self.universe.online && isFailure !== true &&
          !checkFlagDefault(extraFlags, 'nonet', false) &&
          testFolder.serverFolder.type === 'inbox') {
        self.RT.reportActiveActorThisStep(self.ePop3Account);
        self.ePop3Account.expect_createConnection();
      }
      // IMAP has more complicated connection management
      if (self.type === 'imap' && self.universe.online && self.USES_CONN) {
        self.RT.reportActiveActorThisStep(self.eImapAccount);
        // Turn on set matching since connection reuse and account saving are
        // not strongly ordered, nor do they need to be.
        self.eImapAccount.expectUseSetMatching();
        if (isFailure !== true &&
            !checkFlagDefault(extraFlags, 'nonet', false)) {
          self.help_expect_connection();
          if (isFailure === 'deadconn') {
            self.eImapAccount.expect_deadConnection();
            // dead connection will be removed from the pool
            self._unusedConnections--;
          }
          else if (!_saveToThing) {
            self.eImapAccount.expect_releaseConnection();
            if ($sync.KILL_CONNECTIONS_WHEN_JOBLESS) {
              self.eImapAccount.expect_deadConnection('unused');
              self._unusedConnections--;
            }
          }
          else {
            // The connection will be held by the folder/slice, so it's no
            // longer unused.
            self._unusedConnections--;
          }
        }
      }

      // generate expectations for each date sync range
      var totalExpected = self._expect_dateSyncs(
                            _saveToThing ||
                              { testFolder: testFolder,
                                offset: 0, slice: null },
                            expectedValues, extraFlags, null);
      if (expectedValues) {
        if (syncblocked === 'resolve') {
          self.expect_syncblocked();
          // XXX these extra checks in here ideally wouldn't go here, but this
          // is an easy way to make things go without too many extra headaches.
          self.eAccount.expect_runOp_end('do', 'syncFolderList', null);
          self.eAccount.expect_saveAccountState_begin();
          self.eAccount.expect_saveAccountState_end();
          self.eAccount.expect_saveAccountState_begin();
          self.eAccount.expect_saveAccountState_end();
          testFolder.storageActor.expect_mutexedCall_begin('sync');
          testFolder.storageActor.expect_syncedToDawnOfTime();
          testFolder.storageActor.expect_mutexedCall_end('sync');
        }

        // Generate overall count expectation and first and last message
        // expectations by subject.
        self.expect_messagesReported(totalExpected);
        if (totalExpected) {
          self.expect_messageSubjects(
            testFolder.knownMessages.slice(0, totalExpected)
              .map(function(x) { return x.subject; }));
        }
        var callArgs = [expectedFlags.top, expectedFlags.bottom,
                        expectedFlags.growUp || false,
                        expectedFlags.grow,
                        isFailure ? 'syncfailed' : 'synced'];
        if (expectedFlags.newCount !== undefined) {
          callArgs.push(expectedFlags.newCount);
        }
        self.expect_sliceFlags.apply(self, callArgs);
      }
      // If we don't have specific expectations, we still want to wait for the
      // sync to complete.  The exception is that if a syncblocked is reported,
      // then we just expect that...
      else if (!syncblocked) {
        self.expect_viewWithoutExpectationsCompleted();
      }
      else {
        self.expect_syncblocked();
      }

      var slice = self.MailAPI.viewFolderMessages(testFolder.mailFolder);
      if (_saveToThing) {
        _saveToThing.slice = slice;
        testFolder._liveSliceThings.push(_saveToThing);
      }
      if (syncblocked) {
        slice.onstatus = function(status) {
          if (status === 'syncblocked')
            self._logger.syncblocked();
        };
      }
      if (syncblocked !== 'bail') {
        slice.oncomplete = function(newEmailCount) {
          if (expectedValues) {
            self._logger.messagesReported(slice.items.length);
            if (totalExpected) {
              self._logger.messageSubjects(
                slice.items.map(function(x) { return x.subject; }));
            }
            self._logger.sliceFlags(
              slice.atTop, slice.atBottom,
              slice.userCanGrowUpwards,
              slice.userCanGrowDownwards, slice.status,
              newEmailCount === undefined ? null : newEmailCount);
            if (!_saveToThing) {
              slice.die();
            }
          }
          else {
            self._logger.viewWithoutExpectationsCompleted();
          }
        };
      }
    });
    // (varies with N)
    testStep.timeoutMS = 1000 + 400 * testFolder._approxMessageCount;
    return testStep;
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
      if (extraFlags && extraFlags.expectFunc)
        extraFlags.expectFunc();

      // we want this before _expect_dateSyncs because _expect_dateSyncs updates
      // testFolder.initialSynced to be true, which affects this method.
      self._expect_storage_mutexed(viewThing.testFolder, 'refresh', extraFlags);

      var totalExpected = self._expect_dateSyncs(viewThing, expectedValues,
                                                 null, 0);
      self.expect_messagesReported(totalExpected);
      self.expect_headerChanges(viewThing, checkExpected, expectedFlags, null,
                                extraFlags);

      viewThing.slice.refresh();
    });
  },

  /**
   * Given a viewThing from do_openFolderView/etc., get the SliceBridgeProxy
   * corresponding to the viewThing.  Use this if you want to poke and prod at
   * the slice.
   */
  getSliceBridgeProxyForView: function(viewThing) {
    var bridge = this.testUniverse._mailBridge;
    var mailSlice = viewThing.slice;
    var proxy = bridge._slices[mailSlice._handle];
    if (!proxy)
      throw new Error('Unable to find SliceBridgeProxy!');
    return proxy;
  },

  /**
   * Alter the flag-equivalents on the server without affecting our local state.
   */
  modifyMessageFlagsOnServerButNotLocally: function(viewThing, indices,
                                                    addFlags, delFlags) {
    var messages = [];
    var testFolder = viewThing.testFolder;
    indices.forEach(function(index) {
      messages.push(viewThing.slice.items[index]);
    });
    this.testServer.modifyMessagesInFolder(
      testFolder.serverFolder, messages, addFlags, delFlags);
    return messages;
  },

  /**
   * Cause a deletion of the given mail headers to occur on the server without
   * our local state being aware of the changes.  You will need to trigger a
   * refresh for us to see the changes.  (Our model of the server's state,
   * however, will be updated.)
   *
   * For fake servers, this is handled by using our backdoor to manipulate the
   * server directly.  For real servers, this is handled by using our built-in
   * manipulation functions without running the local manipulation.
   *
   * @args[
   *   @param[viewThing folderView]
   *   @param[indices @listof[Number]]{
   *     The indices of the messages to delete in the slice.
   *   }
   * ]
   */
  deleteMessagesOnServerButNotLocally: function(viewThing, indices) {
    var messages = [];
    // sort the indices in descending order so the splices don't mess up
    indices.sort(function(a, b) { return b - a; });
    // - folderView
    var testFolder = viewThing.testFolder;
    indices.forEach(function(index) {
      messages.push(viewThing.slice.items[index]);
      var knownMessage =
            testFolder.knownMessages[viewThing.offset + index];
      var serverIdx = testFolder.serverMessages.indexOf(knownMessage);
      testFolder.serverDeleted.push(knownMessage);
      // XXX the edge cases are concerning, but this logic path is a fallback
      // for a very bounded set of cases, so problems will probably just
      // be dealt with by adding more messages/deleting different messages.
      testFolder.serverDeleted.push({
        below: testFolder.serverMessages[serverIdx - 1],
        above: testFolder.serverMessages[serverIdx + 1]
      });
      testFolder.serverMessages.splice(serverIdx, 1);
    });
    this.testServer.deleteMessagesFromFolder(testFolder.serverFolder,
                                             messages);
    return messages;
  },

  /**
   * Delete one or more messages on the server given a viewThing, then trigger
   * a synchronization so we hear about the deletion.
   *
   * You would want to do this to:
   * - Cause a message header to disappear without a forwarding address.  When
   *   we delete a message and move it to the trash or move a message between
   *   folders, we locally track the movement of the message so that future
   *   references to it can be resolved.  Using this method does not result
   *   in those entries being created because the servers don't tell us these
   *   things.  (At least they don't right now; they might in the future; in
   *   which case we might need to change the name of this method to better
   *   reflect its intended semantics.
   * - Simulate a move or deletion on the server triggered by another client.
   *
   * Under the hood this is just a helper step that calls
   * deleteMessagesOnServerButNotLocally and then calls do_refreshFolderView
   * expecting the given number of deletions to occur.
   */
  do_deleteMessagesOnServerThenRefresh: function(viewThing, indices) {
    var self = this;
    // apart from viewThing the arguments to do_refreshFolderView aren't
    // actually used until step time, so it's fine to compute the values in
    // our first step.
    var expectedValues = {}, checkExpected = {}, expectedFlags = {},
        extraFlags = {};

    this.T.action('delete ' + indices.length + ' headers on server',
                  function() {
      var sliceMessages = viewThing.slice.items;
      var mailHeaders = [];
      indices.forEach(function(index) {
        mailHeaders.push(sliceMessages[index]);
      });
      var preCount = sliceMessages.length,
          postCount = preCount - indices.length;
      expectedValues.count = postCount;
      expectedValues.full = 0;
      expectedValues.flags = postCount;
      expectedValues.changed = 0;
      expectedValues.deleted = indices.length;

      checkExpected.additions = [];
      checkExpected.changes = [];
      checkExpected.deletions = mailHeaders;

      // flags should not change
      expectedFlags.top = viewThing.slice.atTop;
      expectedFlags.bottom = viewThing.slice.atBottom;
      expectedFlags.grow = viewThing.slice.userCanGrowDownwards;

      // We are going to be syncing to the dawn of time if our refresh range
      // covers the most recent message.
      var serverMessages = viewThing.testFolder.serverMessages;
      if (expectedFlags.top)
        extraFlags.syncedToDawnOfTime = true;

      self.deleteMessagesOnServerButNotLocally(viewThing, indices);
    });
    this.do_refreshFolderView(
      viewThing, expectedValues, checkExpected, expectedFlags, extraFlags);
  },

  /**
   * A wrapper around mailHeader.getBody({withBodyReps: true}) that will also
   * remote a request to fetch the body to the main thread where test logic that
   * needs to be on the main thread (ex: instantiating DOM elements or using the
   * HTML parser) can run.  Just use mailHeader.getBody({withBodyReps}) if you
   * don't need the main-thread stuff.
   *
   *    var myHeader;
   *
   *    testAccount.getMessageBodyOnMainThread(
   *      myHeader,
   *      function workerThreadTestContextFunc(body) {
   *      },
   *      function remotedMainThreadFunc(remotedArg, body, sendResults) {
   *        // This can be called asynchronously in the future, but should only
   *        // be called once.
   *        sendResults('main thread says hello!');
   *      },
   *      function gotResultsBackFromMainThread(results) {
   *      });
   *
   */
  getMessageBodyOnMainThread: function(myHeader, callback,
                                       mainThreadArg, onMainThreadFunc,
                                       withMainThreadResults) {
    var testUniverse = this.testUniverse;
    if (onMainThreadFunc) {
      testUniverse.ensureMainThreadMailAPI();
    }

    function sendToMain() {
      if (!onMainThreadFunc)
        return;
      testUniverse._sendHelperMessage(
        'runWithBody',
        {
          headerId: myHeader.id,
          headerDate: myHeader.date.valueOf(),
          arg: mainThreadArg,
          func: onMainThreadFunc.toString()
        },
        function(results) {
          if (withMainThreadResults)
            withMainThreadResults(results);
        });
    }

    myHeader.getBody({ withBodyReps: true }, function(body) {
      callback(body);
      sendToMain();
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

    // If we are going to re-create the folder during this call, we do not
    // expect the mutex to get closed out, and we do not expect the dawn-of-time
    // to happen.
    var recreateFolder = checkFlagDefault(extraFlags, 'recreateFolder', false);
    // Syncblocked bails similarly
    var syncblocked = checkFlagDefault(extraFlags, 'syncblocked', false),
        isFailure = checkFlagDefault(extraFlags, 'failure', false);

    storageActor.expect_mutexedCall_begin(syncType);
    // activesync always syncs the entire folder
    if (this.type === 'activesync') {
      // activesync only syncs when online and when it's a real folder
      if (this.universe.online &&
          testFolder.mailFolder.type !== 'localdrafts' &&
          testFolder.mailFolder.type !== 'outbox' &&
          !recreateFolder && !syncblocked && !isFailure)
        storageActor.expect_syncedToDawnOfTime();
    }
    else if (this.type === 'pop3' && testFolder.mailFolder.type !== 'inbox') {
      // this folder is always local, so this doesn't matter
      storageActor.ignore_syncedToDawnOfTime();
    } else {
      switch (checkFlagDefault(extraFlags, 'syncedToDawnOfTime', false)) {
        case true:
          // per the comment on do_viewFolder, this flag has no meaning when we
          // are refreshing now that we sync FUTUREWARDS.  If we toggle it back
          // to PASTWARDS, comment out this line and things should work.
          if ((syncType === 'sync' && !testFolder.initialSynced) ||
              (syncType === 'grow'))
            storageActor.expect_syncedToDawnOfTime();
          break;
        case 'ignore':
          storageActor.ignore_syncedToDawnOfTime();
          break;
      }
    }
    if (!recreateFolder)
      storageActor.expect_mutexedCall_end(syncType);
    storageActor.ignore_loadBlock_begin();
    storageActor.ignore_loadBlock_end();
    // all of these manipulations are interesting, but they're new and we haven't
    // been generating expectations on these.
    storageActor.ignore_addMessageHeader();
    storageActor.ignore_addMessageBody();
    storageActor.ignore_updateMessageHeader();
    storageActor.ignore_updateMessageBody();
    storageActor.ignore_deleteFromBlock();
  },

  /**
   * @args[
   *   @param[jobName String]{
   *     What job are we expecting to run? ex: 'syncFolderList', 'doownload',
   *     'modtags'.
   *   }
   *   @param[flags @dict[
   *     @key[mode #:default 'do' @oneof['do' 'undo' 'check']]
   *     @key[local #:default true]{
   *       Is a local version of the op expected to run?  Defaults to true for
   *       do/undo, false for check.
   *     }
   *     @key[server #:default true]{
   *       Is a server version of the op expected to be run (which just means no
   *       'local_' prefix)?  Defaults to true.  'check' is considered to be a
   *       server operation for the purposes of our tests.
   *     }
   *     @key[save #:default false @oneof[
   *       @case[false]{
   *         No save operation expected.
   *       }
   *       @case['local']{
   *         Expect a save operation to occur after the local operation.
   *       }
   *       @case[true]{
   *         Same as 'local', deprecated.
   *       }
   *       @case['server']{
   *         Expect a save operation to occur after the "server" operation.
   *       }
   *       @case['both']{
   *         Expect a save after both the local and server operations.  This
   *         does suggest either we move to using 2 different keys or have the
   *         value for local be 'local'.
   *       }
   *     ]]
   *     @key[flushBodyLocalSaves #:default 0 Number]{
   *       Number of flush saves that occur during the local op.
   *     }
   *     @key[flushBodyServerSaves #:default 0 Number]{
   *       Number of flush saves that occur during the server op.
   *     }
   *     @key[conn #:default false @oneof[false true 'create' 'deadconn']{
   *       Expect a connection to be acquired if truthy.  Expect the connection
   *       to die if 'deadconn'.  Expect the connection to be released if `true`
   *       unless explicitly specified othrewise by `release`.
   *     }
   *     @key[release #:optional @oneof[false true 'deadconn']]{
   *       Expect a connection to be released.  If `conn` is true, this
   *       defaults to true, otherwise it defaults to false.  If this is set to
   *       'deadconn', the death of the connection rather than a proper release
   *       is expected (but is only relevant if `conn` is not specified.)
   *     }
   *     @key[error #:default null String]{
   *       The error to expect the job to complete with.
   *     }
   *   ]]
   * ]
   */
  expect_runOp: function(jobName, flags) {
    var mode = checkFlagDefault(flags, 'mode', 'do'), localMode,
        err = checkFlagDefault(flags, 'error', null);
    switch (mode) {
      case 'do':
      case 'undo':
        localMode = 'local_' + mode;
        break;
    }

    var saveCmd = checkFlagDefault(flags, 'save', false);
    var localSave = (saveCmd === true || saveCmd === 'both' ||
                     saveCmd === 'local');
    var serverSave = (saveCmd === 'server' || saveCmd === 'both');
    var flushBodyLocalSaves =
          checkFlagDefault(flags, 'flushBodyLocalSaves', 0);
    var flushBodyServerSaves =
          checkFlagDefault(flags, 'flushBodyServerSaves', 0);

    this.RT.reportActiveActorThisStep(this.eOpAccount);
    // - local
    if (checkFlagDefault(flags, 'local', !!localMode)) {
      this.eOpAccount.expect_runOp_begin(localMode, jobName, null);
      while (flushBodyLocalSaves--) {
        this.eOpAccount.expect_saveAccountState_begin('flushBody');
        this.eOpAccount.expect_saveAccountState_end('flushBody');
      }
      this.eOpAccount.expect_runOp_end(localMode, jobName, err);
    }
    // - save (local)
    if (localSave) {
      this.eOpAccount.expect_saveAccountState_begin('localOp:' + jobName);
      this.eOpAccount.expect_saveAccountState_end('localOp:' + jobName);
    }
    // - server (begin)
    if (checkFlagDefault(flags, 'server', true))
      this.eOpAccount.expect_runOp_begin(mode, jobName);
    while (flushBodyServerSaves--) {
      this.eOpAccount.expect_saveAccountState_begin('flushBody');
      this.eOpAccount.expect_saveAccountState_end('flushBody');
    }
    if (this.USES_CONN) {
      // - conn, (conn) release
      var connMode = checkFlagDefault(flags, 'conn', false);
      if (connMode && ('help_expect_connection' in this)) {
        this.help_expect_connection();
        if (checkFlagDefault(flags, 'conn', false) === 'deadconn') {
          this.eOpAccount.expect_deadConnection();
        }
        // (release is expected by default if we open a conn)
        else if (checkFlagDefault(flags, 'release', true)) {
          this.eOpAccount.expect_releaseConnection();
        }
      }
      // - release (without conn)
      else if (checkFlagDefault(flags, 'release', false) === 'deadconn') {
        this.eOpAccount.expect_deadConnection();
      }
      else if (checkFlagDefault(flags, 'release', false)) {
        this.eOpAccount.expect_releaseConnection();
      }
    }
    // - POP3 conn
    // POP3 bypasses the USES_CONN mechanism because it has simple connection
    // heuristics and exists in a different universe from IMAP and sanity is
    // important to us.  So this is a little hacky, but who really wants to find
    // out the horror that would be the non-hacky solution?  Amirite?
    else if (this.type === 'pop3' &&
             (jobName === 'downloadBodyReps' ||
              jobName === 'downloadBodies') &&
             checkFlagDefault(flags, 'conn', true)) {
      this.eOpAccount.expect_createConnection();
    }
    // - server (end)
    if (checkFlagDefault(flags, 'server', true))
      this.eOpAccount.expect_runOp_end(mode, jobName);
    // - save (server)
    if (serverSave) {
      this.eOpAccount.expect_saveAccountState_begin('serverOp:' + jobName);
      if (!checkFlagDefault(flags, 'interruptServerSave', false)) {
        this.eOpAccount.expect_saveAccountState_end('serverOp:' + jobName);
      }
    }
  },

  /**
   * Wait for a message with the given subject to show up in the
   * account. We first check to see if the message is already in the
   * slice (for POP3, sometimes local operations already have appended
   * the message to a local folder, so it's already there). If it's
   * not, we repeatedly poll for the arrival of the message.
   */
  do_waitForMessage: function(viewThing, expectSubject, funcOpts) {
    var self = this;
    var testStep =
          this.T.action(this, 'wait for message', expectSubject, 'in',
                        viewThing.testFolder, this.eOpAccount,
                        function() {
      self.expect_messageSubject(null, expectSubject);
      var foundIt = false;
      if (funcOpts.expect)
        funcOpts.expect();

      function checkHeader(header) {
        if (header.subject !== expectSubject) {
          return false;
        }
        self._logger.messageSubject(null, header.subject);
        foundIt = true;
        return true;
      }

      // Check if the message is already in the slice:
      for (var i = 0; i < viewThing.slice.items.length; i++) {
        var item = viewThing.slice.items[i];
        if (checkHeader(item)) {
          funcOpts.withMessage.call(funcOpts, item);
          return;
        }
      }

      // If we didn't return in that loop, then we're going to poll.  And
      // currently we're just going to poll once because we only use
      // fake-servers right now.

      // XXX dear future-asuth or future-mcav, present-asuth is very sorry about
      // tightening the expectations here.  Or somewhat sorry, because on real
      // servers maybe we'll use some connection that's not part of the test to
      // ensure that the message arrived at the server.  It will definitely
      // clean up our logs if we can avoid polling over and over!

      // Hey, it's POP3, and POP3 creates a connection for every sync!
      if (self.type === 'pop3') {
        self.ePop3Account.expect_createConnection();
        // it also does batches... so we need one extra save on top of what the
        // next line of code does
        self.expect_saveState();
      }

      // If it's not already there, we will poll for an onadd event, but first
      // let's expect that a database save will cap this all off.
      self.expect_saveState();

      viewThing.slice.onadd = function(header) {
        if (!checkHeader(header)) {
          return;
        }
        // Trigger the withMessage handler only once the slice completes so that
        // we don't try and overlap with the slice's refresh.
        if (funcOpts.withMessage) {
          viewThing.slice.oncomplete =
            funcOpts.withMessage.bind(funcOpts, header);
        }
      }
      function completeFunc() {
        if (foundIt)
          return;
        setTimeout(function() {
          if (foundIt)
            return;
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
   *
   * This should *only* be used when your test involves jobs/operations where
   * you want the header gone and we are currently offline, presumably because
   * you are testing that we don't explode if we encounter a missing header.
   *
   * If your test is currently in the online state and/or you won't race the
   * thing you are testing (or suffer from massive lack of realism), you should
   * use do_deleteMessagesOnServerThenRefresh instead of this method.
   */
  fakeServerMessageDeletion: function(mailHeader) {
    var self = this;

    var suid = mailHeader.id;
    var dateMS = mailHeader.date.valueOf();

    this.RT.reportActiveActorThisStep(this);
    this.expect_deletionNotified(1, suid);

    var folderStorage =
          this.universe.getFolderStorageForMessageSuid(mailHeader.id);

    folderStorage.getMessageHeader(
      suid, dateMS,
      function(header) {
        folderStorage.deleteMessageHeaderAndBodyUsingHeader(header, function() {
          self._logger.deletionNotified(1, header && header.suid);
        });
      });
  },

  /**
   * Create a folder and populate it with a set of messages.  If the folder
   * already exists, remove the folder.  We should already have run
   * syncFolderList by the time this step runs, so we will locally know about
   * the folder and the local folder's state will have to be destroyed.
   */
  do_createTestFolder: function(folderName, messageSetDef, extraFlags) {
    var self = this,
        testFolder = this.T.thing('testFolder', folderName);
    testFolder.connActor = this.T.actor(this.FOLDER_CONN_LOGGER_NAME,
                                        folderName, null, this);
    testFolder.storageActor = this.T.actor('FolderStorage', folderName,
                                           null, this);

    this.T.convenienceSetup('delete test folder', testFolder,
                            'if it exists',
                            function() {
      var existingFolder = self.testServer.getFolderByPath(folderName);
      if (!existingFolder)
        return;

      // The contract for this is that our helper here will ensure that our
      // account has forgotten about the folder too.  This is because for real
      // IMAP we use an actual job/operation to remove the folder.  For our
      // fake implementations we use a backdoor to fast-path the removal of
      // the folder.  We could then trigger a syncFolderList, but the theory
      // is that is both slower and generates more potentially distracting
      // debug, but I don't really feel strongly about how we're handling this.
      self.testServer.removeFolder(existingFolder);
    });

    this.T.convenienceSetup(this.eFolderAccount, 'create test folder',
                            testFolder,
                            function(){

      testFolder.serverFolder = self.testServer.addFolder(folderName,
                                                          testFolder);
      if (self.testServer.SYNC_FOLDER_LIST_AFTER_ADD) {
        self.expect_runOp(
          'syncFolderList',
          { local: false,
            save: (self.supportsServerFolders ? 'server' : false),
            conn: self.USES_CONN });
        self.RT.reportActiveActorThisStep(self);
        self.expect_foundFolder(true);
        self.universe.syncFolderList(self.account, function() {
          self.MailAPI.ping(function() {
            testFolder.mailFolder = self.foldersSlice
                                        .getFirstFolderWithPath(folderName);
            self._logger.foundFolder(!!testFolder.mailFolder,
                                     testFolder.mailFolder);
            testFolder.id = testFolder.mailFolder.id;
            testFolder.connActor.__attachToLogger(
              self.testUniverse.__folderConnLoggerSoup[testFolder.id]);
            testFolder.storageActor.__attachToLogger(
              self.testUniverse.__folderStorageLoggerSoup[testFolder.id]);
          });
        });
      }
    });

    if (messageSetDef.hasOwnProperty('count') &&
        messageSetDef.count === 0) {
      testFolder.serverMessages = [];
      return testFolder;
    }

    this._do_addMessagesToTestFolder(testFolder, 'populate test folder',
                                     messageSetDef, extraFlags);

    return testFolder;
  },

  /**
   * Re-create the folder from scratch so that we can reset all the state on
   * the folder.  This means all the headers and bodies will go away, etc.
   */
  do_recreateFolder: function(testFolder) {
    var self = this;
    this.T.action(this, 're-create folder', testFolder, 'of',
                  self.eFolderAccount, function() {
      // - runtime flags!
      // (serverMessages is unchanged)
      testFolder.knownMessages = [];
      // (serverDelete is unchanged)
      testFolder.initialSynced = false;

      self.expect_folderRecreated();
      self._expect_recreateFolder(testFolder);
      self.folderAccount._recreateFolder(testFolder.id, function() {
        self._logger.folderRecreated();
      });
    });
  },

  /**
   * Common log for folder re-creations.  Exists so that ActiveSync and IMAP
   * can expect a folder re-creation during the sync process when they realize
   * the SyncKey is or UIDVALIDITY has rolled, while unit tests can explicitly
   * trigger a folder re-creation.
   */
  _expect_recreateFolder: function(testFolder) {
    var self = this;
    this.eFolderAccount.expect_recreateFolder();
    this.eFolderAccount.expect_saveAccountState_begin('recreateFolder');
    this.eFolderAccount.expect_saveAccountState_end('recreateFolder');

    var oldConnActor = testFolder.connActor;
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
    var newConnActor = this.T.actor(this.FOLDER_CONN_LOGGER_NAME, newActorName,
                                    null, this),
        newStorageActor = this.T.actor('FolderStorage', newActorName,
                                       null, this);
    this.RT.reportActiveActorThisStep(newConnActor);
    this.RT.reportActiveActorThisStep(newStorageActor);

    testFolder.connActor = newConnActor;
    testFolder.storageActor = newStorageActor;

    return newConnActor;
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
  _do_addMessagesToTestFolder: function(testFolder, desc, messageSetDef,
                                        extraFlags) {
    var self = this;
    var messageCount = checkFlagDefault(extraFlags, 'messageCount', false) ||
                       messageSetDef.count;
    this.T.convenienceSetup(this, desc, testFolder, function() {
      var messageBodies;
      if (messageSetDef instanceof Function) {
        messageBodies = messageSetDef();
      }

      else {
        var generator = self.testUniverse.messageGenerator;
        generator._clock = self._useDate ? new Date(self._useDate) : null;
        messageBodies = generator.makeMessages(messageSetDef);
      }

      if (extraFlags && extraFlags.pushMessagesTo) {
        var pushMessagesTo = extraFlags.pushMessagesTo;
        pushMessagesTo.push.apply(pushMessagesTo, messageBodies);
      }
      if (checkFlagDefault(extraFlags, 'doNotExpect', false)) {
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

      self.testServer.addMessagesToFolder(testFolder.serverFolder,
                                          messageBodies);
    }).timeoutMS = 1000 + 600 * messageCount; // appending can take a bit.
  },

  /**
   * Add messages to an existing test folder.
   */
  do_addMessagesToFolder: function(testFolder, messageSetDef, extraFlags) {
    this._do_addMessagesToTestFolder(testFolder, 'add messages to',
                                     messageSetDef, extraFlags);
  },

  /**
   * Add a single message to an existing test folder.
   */
  do_addMessageToFolder: function(testFolder, messageDef, extraFlags) {
    var self = this;
    this._do_addMessagesToTestFolder(testFolder, 'add message to', function() {
      var generator = self.testUniverse.messageGenerator;
      return [generator.makeMessage(messageDef)];
    }, extraFlags);
  },

  /**
   * Use a folder that should already exist because of a prior test step or
   * because it's a special folder that should already exist on the server,
   * identifying the folder by name.
   */
  do_useExistingFolder: function(folderName, suffix, oldFolder) {
    var self = this,
        testFolder = this.T.thing('testFolder', folderName + suffix);
    testFolder.connActor = this.T.actor(this.FOLDER_CONN_LOGGER_NAME,
                                        folderName, null, this);
    testFolder.storageActor = this.T.actor('FolderStorage', folderName,
                                           null, this);
    testFolder._approxMessageCount = 30;

    this.T.convenienceSetup('find test folder', testFolder, function() {
      testFolder.mailFolder =
        self.foldersSlice.getFirstFolderWithName(folderName);
      testFolder.id = testFolder.mailFolder.id;
      if (oldFolder) {
        testFolder.serverFolder = oldFolder.serverFolder;
        testFolder.serverMessages = oldFolder.serverMessages;
        testFolder.knownMessages = oldFolder.knownMessages;
        testFolder.serverDeleted = oldFolder.serverDeleted;
        testFolder.initialSynced = oldFolder.initialSynced;
      }
      else {
        // Establish a testing layer linkage.  In order to manipulate the
        // folder further we need a serverFolder handle, and our expectation
        // logic needs to know the messages already present on the server.
        testFolder.serverFolder = self.testServer.getFolderByPath(folderName);
        testFolder.serverMessages =
          self.testServer.getMessagesInFolder(testFolder.serverFolder);
      }

      testFolder.connActor.__attachToLogger(
        self.testUniverse.__folderConnLoggerSoup[testFolder.id]);
      testFolder.storageActor.__attachToLogger(
        self.testUniverse.__folderStorageLoggerSoup[testFolder.id]);
    });
    return testFolder;
  },

  /**
   * Use a folder that should already exist because of a prior test step or
   * because it's a special folder that should already exist on the server,
   * identifying the folder by type.
   */
  do_useExistingFolderWithType: function(folderType, suffix, oldFolder) {
    var self = this,
        folderName = folderType + suffix,
        testFolder = this.T.thing('testFolder', folderName);
    testFolder.connActor = this.T.actor(this.FOLDER_CONN_LOGGER_NAME,
                                        folderName, null, this);
    testFolder.storageActor = this.T.actor('FolderStorage', folderName,
                                           null, this);
    testFolder._approxMessageCount = 30;

    this.T.convenienceSetup('find test folder', testFolder, function() {
      testFolder.mailFolder =
        self.foldersSlice.getFirstFolderWithType(folderType);
      testFolder.id = testFolder.mailFolder.id;
      if (oldFolder) {
        testFolder.serverFolder = oldFolder.serverFolder;
        testFolder.serverMessages = oldFolder.serverMessages;
        testFolder.knownMessages = oldFolder.knownMessages;
        testFolder.serverDeleted = oldFolder.serverDeleted;
        testFolder.initialSynced = oldFolder.initialSynced;
      }
      // some folders do not exist on the server; don't bother the server!
      else if (folderType !== 'localdrafts' && folderType !== 'outbox') {
        // Establish a testing layer linkage.  In order to manipulate the
        // folder further we need a serverFolder handle, and our expectation
        // logic needs to know the messages already present on the server.
        testFolder.serverFolder = self.testServer.getFolderByPath(
          testFolder.mailFolder.path);
        testFolder.serverMessages =
          self.testServer.getMessagesInFolder(testFolder.serverFolder);
      }

      testFolder.connActor.__attachToLogger(
        self.testUniverse.__folderConnLoggerSoup[testFolder.id]);
      testFolder.storageActor.__attachToLogger(
        self.testUniverse.__folderStorageLoggerSoup[testFolder.id]);
    });
    return testFolder;
  },

  /**
   * Delete the account.  This is done using the front-end MailAPI for no
   * particular reason other than we need to use ping() to make sure all the
   * events have hit the ostensible front-end before declaring the step over.
   *
   * @param stepType {'action'|'cleanup'}
   */
  do_deleteAccount: function(stepType) {
    var self = this;
    this.T[stepType]('delete', this, function() {
      self.expect_accountDeleted();

      // Fake the account because we don't have easy-access to the MailAccount
      // in here and we don't really need it.
      self.MailAPI._deleteAccount({ id: self.accountId });
      self.MailAPI.ping(function() {
        self._logger.accountDeleted();
      });
    });
  },

  /**
   * Expect that we will send a message. This entails moving the draft
   * to the outbox, triggering a sendOutboxMessages job, and actually
   * sending the message.
   *
   * @param {String} successOrFailure
   *   Pass 'success' if you expect us to succeed or 'failure' if you expect us
   *   to fail.
   * @param {String|Boolean} conn
   *   Pass 'conn' to indicate a connection is expected desired.  XXX I have no
   *   idea why this would not always be passed?  This should probably be
   *   removed.
   */
  expect_sendMessageWithOutbox: function(successOrFailure, /*optional*/ conn) {
    this.expect_moveMessageToOutbox();
    this.expect_sendOutboxMessages();
    if (successOrFailure !== 'failure') {
      this.expect_saveSentMessage(conn);
    }
  },

  /**
   * Expect that we will move a message to the outbox, thereby
   * automatically kicking off a sendOutboxMessages job.
   */
  expect_moveMessageToOutbox: function() {
    this.expect_runOp(
      'move',
      { local: true,
        server: false,
        save: 'local' });
  },

  /**
   * Expect that we will run one instance of the `sendOutboxMessages` job.
   */
  expect_sendOutboxMessages: function(successOrFailure) {
    this.expect_runOp(
      'sendOutboxMessages',
      { local: false,
        server: true,
        save: 'server' });
  },

  /**
   * Helper method to compose and send a message which either results in
   * success or failure; you tell us which is gonna happen, and we expect the
   * right things.  (We're not psychic.)
   *
   * Use this to get messages in the outbox!
   *
   * @param {string} subject
   *   Subject for this message.
   * @param {object} opts
   *   Optional test-specific things. This could be cleaned up.
   * @param {string} opts.to
   *   Override the message's address with this parameter.
   * @param {array} [opts.existingRetryResults]
   *   A list with one item for each already existing message in the outbox where
   *   the item is 'success' if we expect the send to succeed, or false if we
   *   expect it to fail.
   * @param {object} [opts.outboxView]
   *   If you want us to check that there are the right number of messages in
   *   the outbox, pass us an open viewThing.
   * @param {boolean} opts.success
   *   If true, assert things that indicate that the message sent successfully.
   *   Otherwise, assert that the message failed to send, and is still in the
   *   outbox.
   */
  do_composeAndSendMessage: function (subject, opts) {
    var shouldSucceed = opts.success;
    var TEST_PARAMS = this.RT.envOptions;
    var composer;

    this.T.action(this, 'begin composition', function() {
      this.expect_composerReady();
      var inboxMailFolder =
            this.foldersSlice.getFirstFolderWithType('inbox');
      composer = this.MailAPI.beginMessageComposition(
        null, inboxMailFolder, null,
        this._logger.composerReady.bind(this._logger));
    }.bind(this));

    this.T.action(this, 'compose and send', function() {
      composer.to.push({ name: 'Myself',
                         address: opts.to || TEST_PARAMS.emailAddress });
      composer.subject = subject;
      composer.body.text = 'Antelope banana credenza.\n\nDialog excitement!';
      this.expect_runOp(
        'saveDraft',
        { local: true, server: false, save: 'local' });

      if (shouldSucceed) {
        this.expect_sendMessageWithOutbox('success', 'conn');
        this.expect_sendCompleted('success');
      } else {
        this.expect_moveMessageToOutbox();
        this.expect_sendOutboxMessages();
        this.expect_sendCompleted('error');
      }

      var existingRetryResults = opts.existingRetryResults || [];
      var outboxView = opts.outboxView;
      if (outboxView &&
          existingRetryResults.length < outboxView.slice.items.length - 1) {
        throw new Error('Incorrect existingRetryResults argument provided; ' +
                        'length is ' + existingRetryResults.length + ' but ' +
                        'should be ' + (outboxView.slice.items.length - 1));
      }
      for (var i = 0; i < existingRetryResults.length; i++) {
        this.expect_sendOutboxMessages();
        if (existingRetryResults[i] === 'success') {
          this.expect_saveSentMessage();
        }
      }

      this.expect_accountOpsCompleted();
      this.MailAPI.onbackgroundsendstatus = function(data) {
        if (!data.emitNotifications) {
          return;
        }
        // we only care about termination; not 'sending'
        if (data.state === 'success' || data.state === 'error') {
          this._logger.sendCompleted(data.state);
          this.MailAPI.onbackgroundsendstatus = null;
          this.universe.waitForAccountOps(
            this.account,
            this._logger.accountOpsCompleted.bind(this._logger));
        }
      }.bind(this);

      composer.finishCompositionSendMessage();
    }.bind(this)).timeoutMS = TEST_PARAMS.slow ? 10000 : 5000;
  },
};

var TestFolderMixins = {
  __constructor: function() {
    this.connActor = null;
    this.storageActor = null;
    this.id = null;
    // the front-end MailAPI MailFolder instance for the folder
    this.mailFolder = null;
    // fake-server folder rep, if we are using a fake-server
    this.serverFolder = null;
    // messages on the server
    this.serverMessages = null;
    this.serverDeleted = [];
    // messages that should be known to the client based on the sync operations
    //  we have generated expectations for.
    this.knownMessages = [];
    // this is a runtime flag!
    this.initialSynced = false;

    this._approxMessageCount = 0;
    this._liveSliceThings = [];
  },

  findServerMessage: function(guid) {
    var rep;
    var msgs = this.serverMessages;

    for (var i = 0; i < msgs.length; i++) {
      var msg = msgs[i];

      if (msg.messageId === guid)
        return msg;
    }

    throw new Error('Unable to find message with guid: ' + guid);
  },

  serverMessageContent: function(guid, idx) {
    var message = this.findServerMessage(guid);
    // XXX: this code gets repeated a few times; put it in messageGenerator?
    var bodyPart = message.bodyPart;
    while (bodyPart.parts) {
      bodyPart = bodyPart.parts[0];
    }

    if (bodyPart._contentType === 'text/html')
      return bodyPart.body;
    else
      return [0x1, bodyPart.body];
  },
};

var TestCompositeAccountMixins = {
  exactAttachmentSizes: false,
  FOLDER_CONN_LOGGER_NAME: 'ImapFolderConn',
  USES_CONN: true,
  supportsServerFolders: true,

  __constructor: function(self, opts) {
    // for logging, etc, something capitalized
    var Type = self.Type = (self.type === 'imap' ? 'Imap' : 'Pop3');
    var TYPE = self.TYPE = self.type.toUpperCase();

    if (self.type === 'pop3') {
      self.USES_CONN = false;
      self.FOLDER_CONN_LOGGER_NAME = 'Pop3FolderSyncer';
      self.supportsServerFolders = false;
      self.exactAttachmentSizes = true;
    }

    self.eOpAccount = self.eFolderAccount =
      self.T.actor(Type + 'Account', self.__name, null, self);

    if (self.type === 'imap') {
      self.eImapAccount = self.eFolderAccount;
    } else {
      self.ePop3Account = self.eFolderAccount;
    }

    self.eJobDriver = self.T.actor(Type + 'JobDriver', self.__name, null, self);
    self.eBackoff = self.T.actor('BackoffEndpoint', self.__name, null, self);

    var TEST_PARAMS = self.RT.envOptions;

    self.imapHost = self.pop3Host = null;
    self.imapPort = self.pop3Port = null;

    /**
     * Very simple/primitive connection book-keeping.  We only alter this in
     * a test step if the connection will outlive the step, such as when
     * opening a slice and leaving it open.  A single step that opens
     * multiple connections is beyond our automated ken and needs to either be
     * manually handled or update this common logic.
     */
    self._unusedConnections = 0;

    if ('controlServerBaseUrl' in TEST_PARAMS) {
      self.testServer = self.T.actor(
        'testFake' + TYPE + 'Server', self.__name,
        {
          testAccount: self,
          restored: opts.restored,
          imapExtensions: opts.imapExtensions,
          deliveryMode: opts.deliveryMode
        },
        null, self);
    }
    else {
      self.testServer = self.T.actor(
        'testReal' + TYPE + 'Server', self.__name,
        {
          testAccount: self,
          restored: opts.restored
        },
        null, self);
    }

    if (opts.restored) {
      self.testUniverse.__restoredAccounts.push(this);
      self._do_issueRestoredAccountQueries();
    }
    else {
      self._do_createAccount();
    }
  },

  ignore_connectionStuff: function() {
    // both imap and pop3 share the same logger stuff.
    this.eFolderAccount.ignore_createConnection();
    this.eFolderAccount.ignore_reuseConnection();
    this.eFolderAccount.ignore_releaseConnection();
  },

  expect_shutdown: function() {
    this.RT.reportActiveActorThisStep(this.eFolderAccount);
    this.eFolderAccount.expectOnly__die();
  },

  expect_saveState: function() {
    this.RT.reportActiveActorThisStep(this.eFolderAccount);
    this.eFolderAccount.expect_saveAccountState_begin();
    this.eFolderAccount.expect_saveAccountState_end();
  },

  help_expect_connection: function() {
    // POP3 set USES_CONN to false and accordingly will not call this method,
    // but let's sorta assert on that
    if (this.type === 'pop3') {
      throw new Error('pop3 control flow should not go in here');
    }

    if (!this._unusedConnections) {
      this.eFolderAccount.expect_createConnection();
      // caller will need to decrement this if they are going to keep the
      // connection alive; we are expecting it to become available again at
      // the end of the step...
      this._unusedConnections++;
    }
    this.eFolderAccount.expect_reuseConnection();
  },

  _expect_restore: function() {
    this.RT.reportActiveActorThisStep(this.eFolderAccount);
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
      self.folderAccount = self.compositeAccount._receivePiece;
      if (self.type === 'imap') {
        self.imapAccount = self.folderAccount;
      } else {
        self.pop3Account = self.folderAccount;
      }
      self.smtpAccount = self.compositeAccount._sendPiece;
      self.accountId = self.compositeAccount.id;

      var receiveConnInfo = self.compositeAccount.accountDef.receiveConnInfo;
      self.imapHost = self.pop3Host = receiveConnInfo.hostname;
      self.imapPort = self.pop3Port = receiveConnInfo.port;

      self._expect_commonTestAccountConfig();
      self._help_commonTestAccountConfig();

      self.testServer.finishSetup(self);
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

      self.RT.reportActiveActorThisStep(self.eFolderAccount);
      self.RT.reportActiveActorThisStep(self.eJobDriver);
      self.RT.reportActiveActorThisStep(self.eBackoff);

      self.universe = self.testUniverse.universe;
      self.MailAPI = self.testUniverse.MailAPI;
      self.rawAccount = null;

      self._expect_commonTestAccountConfig();

      // we expect the connection to be reused and release to sync the folders
      if (self.type === 'imap') {
        self._unusedConnections = 1;
        self.eFolderAccount.expect_runOp_begin('do', 'syncFolderList');
        self.help_expect_connection();
        self.eFolderAccount.expect_releaseConnection();
        self.eFolderAccount.expect_runOp_end('do', 'syncFolderList');
        // we expect the account state to be saved after syncing folders
        self.eFolderAccount.expect_saveAccountState_begin();
        self.eFolderAccount.expect_saveAccountState_end();
      }

      if (self._opts.timeWarp)
        $date.TEST_LetsDoTheTimewarpAgain(self._opts.timeWarp);

      var TEST_PARAMS = self.RT.envOptions;
      self.MailAPI.tryToCreateAccount(
        {
          displayName: self.displayName,
          emailAddress: self.emailAddress,
          password: self.initialPassword,
          accountName: self._opts.name || null, // null means use email
          forceCreate: self._opts.forceCreate
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

          self.folderAccount = self.compositeAccount._receivePiece;
          if (self.type === 'imap') {
            self.imapAccount = self.folderAccount;
          } else {
            self.pop3Account = self.folderAccount;
          }
          self.smtpAccount = self.compositeAccount._sendPiece;

          var receiveConnInfo =
                self.compositeAccount.accountDef.receiveConnInfo;
          self.imapHost = self.pop3Host = receiveConnInfo.hostname;
          self.imapPort = self.pop3Port = receiveConnInfo.port;

          self._help_commonTestAccountConfig();

          self.testServer.finishSetup(self);
        });
    }).timeoutMS = 10000; // there can be slow startups...
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
      var thresh = $date.quantizeDate(array[idx].date.valueOf() +
                                      (dir === -1 ? 0 : $date.DAY_MILLIS));
      var i;
      if (dir === -1) {
        for (i = idx - 1; i >= 0; i--) {
          if ($date.STRICTLY_AFTER(array[idx].date, thresh))
            break;
        }
        return i + 1;
      }
      else {
        for (i = idx + 1; i < array.length; i++) {
          if ($date.ON_OR_BEFORE(array[idx].date, thresh))
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
            //console.log('MERGE add', knownIdx, serverHeader.subject);
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

  // this is intentionally different between IMAP and ActiveSync because
  // their sync logic is so different. (This one is IMAP/POP3.)
  _expect_dateSyncs: function(viewThing, expectedValues, extraFlags,
                              syncDir) {
    var testFolder = viewThing.testFolder;
    this.RT.reportActiveActorThisStep(this.eFolderAccount);
    this.RT.reportActiveActorThisStep(testFolder.connActor);
    var totalMessageCount = 0,
        nonet = checkFlagDefault(extraFlags, 'nonet', false),
        isFailure = checkFlagDefault(extraFlags, 'failure', false);

    if (expectedValues) {
      if (!Array.isArray(expectedValues))
        expectedValues = [expectedValues];

      var propState = null;
      for (var i = 0; i < expectedValues.length; i++) {
        var einfo = expectedValues[i];
        totalMessageCount += einfo.count;
        if (this.universe.online && !nonet && !isFailure) {
          propState = this._propagateToKnownMessages(
            viewThing, propState,
            einfo.count, einfo.full, einfo.deleted, syncDir);
          if (this.type === 'imap') {
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
          // implied: this.type === 'pop3'
          } else if (testFolder.serverFolder.type === 'inbox') {
            testFolder.connActor.expect_sync_begin();
            testFolder.connActor.expect_sync_end();
          }
        }
      }
    }
    if (this.universe.online && !nonet) {
      testFolder.initialSynced = true;
      if (!checkFlagDefault(extraFlags, 'nosave', false)) {
        // POP3 has both periodic batch syncs and syncComplete syncs
        if (this.type === 'pop3') {
          // POP3 only syncs in the inbox, although there is a sketchy test-only
          // path to deal with additions / deletions in these test folders that
          // only exist in testing scenarios.
          if (testFolder.serverFolder.type === 'inbox') {
            var syncBatches = checkFlagDefault(extraFlags, 'batches',
                                               totalMessageCount ? 1 : 0);
            for (var iBatch = 0; iBatch < syncBatches; iBatch++) {
              this.eFolderAccount.expect_saveAccountState_begin('syncBatch');
              this.eFolderAccount.expect_saveAccountState_end('syncBatch');
            }
            this.eFolderAccount.expect_saveAccountState_begin('syncComplete');
            this.eFolderAccount.expect_saveAccountState_end('syncComplete');
          }
        }
        // IMAP only saves once per sync
        else {
          this.expect_saveState();
        }
      }
    }
    else {
      // Make account saving cause a failure; also, connection reuse, etc.
      this.eFolderAccount.expectNothing();
      if (nonet)
        testFolder.connActor.expectNothing();
    }

    return totalMessageCount;
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
      if (extraFlags && extraFlags.expectFunc)
        extraFlags.expectFunc();

      // POP3! Arrrrgggghhh
      if (self.type === 'pop3' && self.universe.online &&
          viewThing.testFolder.serverFolder.type === 'inbox') {
        self.RT.reportActiveActorThisStep(self.ePop3Account);
        self.ePop3Account.expect_createConnection();
      }

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
        expectedFlags, null, extraFlags);
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
                 return x.subject;
               }));
      var callArgs = [expectedFlags.top, expectedFlags.bottom,
                      expectedFlags.growUp || false,
                      expectedFlags.grow,
                      'synced'];
      if (expectedFlags.newCount !== undefined)
        callArgs.push(expectedFlags.newCount);
      self.expect_sliceFlags.apply(self, callArgs);

      viewThing.slice.onsplice = function(index, howMany, added,
                                          requested, moreExpected) {
        self._logger.splice(index, howMany);
      };
      viewThing.slice.oncomplete = function(newEmailCount) {
        viewThing.slice.onsplice = null;

        self._logger.messagesReported(viewThing.slice.items.length);
        self._logger.messageSubjects(
          viewThing.slice.items.map(function(x) { return x.subject; }));
        self._logger.sliceFlags(
          viewThing.slice.atTop, viewThing.slice.atBottom,
          viewThing.slice.userCanGrowUpwards,
          viewThing.slice.userCanGrowDownwards,
          viewThing.slice.status,
          newEmailCount === undefined ? null : newEmailCount);
      };

      viewThing.slice.requestShrinkage(useLow, useHigh);
    });
  },

  expect_saveSentMessage: function(conn) {
    // sending is not tracked as an op, but saving the sent message is
    if (this.type === 'imap') {
      this.expect_runOp(
        'append',
        { local: false, server: true, save: false, conn: conn });
    }
    else if (this.type === 'pop3') {
      this.expect_runOp(
        'saveSentDraft',
        { local: true, server: false, save: true, conn: false });
    }
  },
};

var TestActiveSyncAccountMixins = {
  exactAttachmentSizes: true,
  FOLDER_CONN_LOGGER_NAME: 'ActiveSyncFolderConn',
  USES_CONN: false,
  supportsServerFolders: true,

  __constructor: function(self, opts) {
    self.eAccount = self.eOpAccount = self.eFolderAccount =
      self.T.actor('ActiveSyncAccount', self.__name, null, self);
    self.eJobDriver =
      self.T.actor('ActiveSyncJobDriver', self.__name, null, self);


    var TEST_PARAMS = self.RT.envOptions;
    if (opts.realAccountNeeded) {
      if (TEST_PARAMS.defaultArgs)
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
    else {
      self.testServer = self.T.actor(
        'testActiveSyncServer', self.__name,
        {
          testAccount: self,
          universe: opts.universe,
          deliveryMode: opts.deliveryMode
        },
        null, self);
    }

    // dummy attributes to be more like IMAP to reuse some logic:
    self._unusedConnections = 0;

    if (opts.restored) {
      self.testUniverse.__restoredAccounts.push(this);
      self._do_issueRestoredAccountQueries(opts.restored);
    }
    else {
      self._do_createAccount();
    }
  },

  _do_issueRestoredAccountQueries: function(restoreType) {
    var self = this;
    self.T.convenienceSetup(self, 'issues helper queries', function() {
      self.__attachToLogger(LOGFAB.testAccount(self, null, self.__name));

      self.universe = self.testUniverse.universe;
      self.MailAPI = self.testUniverse.MailAPI;

      var idxAccount = self.testUniverse.__testAccounts.indexOf(self);
      self.folderAccount = self.account = self.universe.accounts[idxAccount];
      self.accountId = self.account.id;

      self._expect_commonTestAccountConfig();
      self._help_commonTestAccountConfig();

      self.testServer.finishSetup(self);
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
      self.RT.reportActiveActorThisStep(self.eJobDriver);
      self.expect_runOp('syncFolderList', { local: false, save: 'server' });
      self._expect_commonTestAccountConfig();

      self.universe = self.testUniverse.universe;
      self.MailAPI = self.testUniverse.MailAPI;

      var TEST_PARAMS = self.RT.envOptions;
      self.MailAPI.tryToCreateAccount(
        {
          displayName: self.displayName,
          emailAddress: self.emailAddress,
          password: self.initialPassword,
          accountName: self._opts.name || null, // null means use email
          forceCreate: self._opts.forceCreate
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
              self.folderAccount = self.account = self.universe.accounts[i];
              break;
            }
          }

          if (!self.account)
            do_throw('Unable to find account for ' + TEST_PARAMS.emailAddress +
                     ' (id: ' + self.accountId + ')');

          self._help_commonTestAccountConfig();

          self.testServer.finishSetup(self);
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
    this.eAccount.expect_saveAccountState_begin();
    this.eAccount.expect_saveAccountState_end();
  },

  _expect_restore: function() {
    this.RT.reportActiveActorThisStep(this.eAccount);
  },

  // this is intentionally different between IMAP and ActiveSync because
  // their sync logic is so different. (This one is ActiveSync.)
  _expect_dateSyncs: function(viewThing, expectedValues, extraFlags,
                              syncDir) {
    var testFolder = viewThing.testFolder;
    this.RT.reportActiveActorThisStep(this.eAccount);
    this.RT.reportActiveActorThisStep(testFolder.connActor);
    var totalMessageCount = 0,
        nonet = checkFlagDefault(extraFlags, 'nonet', false);

    if (expectedValues) {
      if (!Array.isArray(expectedValues))
        expectedValues = [expectedValues];

      for (var i = 0; i < expectedValues.length; i++) {
        var einfo = expectedValues[i];
        totalMessageCount += einfo.count;
        if (this.universe.online && !nonet) {
          // The client should know about all of the messages on the server
          // after a sync.  If we start modeling the server only telling us
          // things in chunks, we will want to do something more clever here,
          // a la _propagateToKnownMessages
          testFolder.knownMessages = testFolder.serverMessages.concat();

          testFolder.connActor.expect_sync_begin(null, null, null);
          // TODO: have filterType be specified in extraFlags for consistency
          // with IMAP.
          // XXX we might also consider inferring some cases?
          if (einfo.filterType) {
            if (einfo.filterType === 'none')
              einfo.filterType = '0';
            testFolder.connActor.expect_inferFilterType(einfo.filterType);
          }
          if (checkFlagDefault(extraFlags, 'recreateFolder', false)) {
            var oldConnActor = testFolder.connActor;
            var newConnActor = this._expect_recreateFolder(testFolder);

            oldConnActor.expect_sync_end(null, null, null);

            newConnActor.expect_sync_begin(null, null, null);
            newConnActor.expect_sync_end(
              einfo.full, einfo.changed === undefined ? 0 : einfo.changed,
              einfo.deleted);
          }
          else {
            testFolder.connActor.expect_sync_end(
              einfo.full, einfo.changed === undefined ? 0 : einfo.changed,
              einfo.deleted);
          }
        }
      }
    }
    if (this.universe.online && !nonet &&
        !checkFlagDefault(extraFlags, 'nosave', false)) {
      this.eAccount.expect_saveAccountState_begin();
      this.eAccount.expect_saveAccountState_end();
    }
    // (the accountActive check is a hack for test_activesync_recreate
    // right now. It passes in nosave because the expected save comes at a
    // bad time, but then we want to generate other expectations...)
    else if (!checkFlagDefault(extraFlags, 'accountActive', false)) {
      // Make account saving cause a failure; also, connection reuse, etc.
      this.eAccount.expectNothing();
      if (nonet)
        testFolder.connActor.expectNothing();
    }

    return totalMessageCount;
  },

  expect_saveSentMessage: function() {
  },
};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  bridgeSnoop: {
    type: $log.CLIENT,
    subtype: $log.CLIENT,
    events: {
      apiSend: { type: false, msg: false },
      apiDefer: { type: false, msg: false },
      apiProcess: { type: false, msg: false },
      bridgeSend: { type: false, msg: false },
    },
  },
  console: {
    type: $log.LOGGING,
    events: {
      log: { msg: false },
      error: { msg: false },
      info: { msg: false},
      warn: { msg: false },
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

      killedOperations: { type: true, length: true, ops: false,
                          remaining: false  },
      operationsDone: {},

      cleanShutdown: {},

      apiCronSyncStartReported: { accountIds: false },
      apiCronSyncStopReported: { accountsResults: false },
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
      accountDeleted: {},
      foundFolder: { found: true, rep: false },
      folderSlicePopulated: {},

      // the accounts recreateFolder notification should be converted to an
      // async process with begin/end, replacing this.
      folderRecreated: {},

      deletionNotified: { count: true },
      sliceDied: { handle: true },

      manipulationNotified: {},

      splice: { index: true, howMany: true },
      sliceFlags: { top: true, bottom: true, growUp: true, growDown: true,
                    status: true, newCount: true },
      syncblocked: {},
      messagesReported: { count: true },
      messageSubject: { index: true, subject: true },
      messageSubjects: { subjects: true },
      // This is used when we've decided to not emit messagesReported/sliceFlags
      // because we don't care what's in the folder.  This is used primarily
      // for real servers where we can't destroy the folder and we don't care
      // what's in it.
      viewWithoutExpectationsCompleted: {},

      changesReported: { additions: true, changes: true, deletions: true },

      accountModified: {},
      identityModified: {},

      composerReady: {},
      sendCompleted: { result: true },
      // Dubious but semantically explicit waiting for operations to complete
      // to make sure the test step catches everything that happens inside it.
      // Since waitForAccountOpts is a MailUniverse thing, this inherently leads
      // to potential races against the front-end and may be a bad idea unless
      // a MailAPI.ping is also being used.
      accountOpsCompleted: {},

      mutexStolen: { folderType: true },
      mutexReturned: { folderType: true },
      interceptedAccountSave: {},
      releasedAccountSave: {},
    },
    errors: {
      accountCreationError: { err: false },

      unexpectedChange: { subject: false },
      changeMismatch: { field: false, expectedValue: false },
    },
  },
});

exports.TESTHELPER = {
  LOGFAB_DEPS: [
    LOGFAB,
    $mailuniverse.LOGFAB, $mailbridge.LOGFAB,
    $mailslice.LOGFAB, $searchfilter.LOGFAB,
    $errbackoff.LOGFAB, $cronsync.LOGFAB,
    // IMAP!
    $imapacct.LOGFAB, $imapfolder.LOGFAB, $imapjobs.LOGFAB,
    // POP3!
    $pop3acct.LOGFAB, $pop3sync.LOGFAB, $pop3jobs.LOGFAB,
    // ActiveSync!
    $activesyncacct.LOGFAB, $activesyncfolder.LOGFAB, $activesyncjobs.LOGFAB,
  ],
  TESTHELPER_DEPS: [
    $th_fake_as_server.TESTHELPER,
    $th_fake_imap_server.TESTHELPER,
    $th_fake_pop3_server.TESTHELPER,
    $th_real_imap_server.TESTHELPER,
  ],
  actorMixins: {
    testUniverse: TestUniverseMixins,
    testAccount: TestCommonAccountMixins,
  },
  thingMixins: {
    testFolder: TestFolderMixins,
  },
};

});

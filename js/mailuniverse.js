define(function(require) {
'use strict';

let logic = require('./logic');
let slog = require('./slog');
let $a64 = require('./a64');
let $date = require('./date');
let $syncbase = require('./syncbase');
let $router = require('./worker-router');
let MailDB = require('./maildb');
let $acctcommon = require('./accountcommon');
let $allback = require('./allback');

let AccountsTOC = require('./db/accounts_toc');
let FolderConversationsTOC = require('./db/folder_convs_toc');
let FoldersTOC = require('./db/folders_toc');
let ConversationTOC = require('./db/conv_toc');

let TaskManager = require('./task_manager');

// require lazy_tasks for the side-effect of defining the tasks we implement.
require('./lazy_tasks');

/**
 * When debug logging is enabled, how many second's worth of samples should
 * we keep?
 */
var MAX_LOG_BACKLOG = 30;

/**
 * The MailUniverse is the keeper of the database, the root logging instance,
 * and the mail accounts.  It loads the accounts from the database on startup
 * asynchronously, so whoever creates it needs to pass a callback for it to
 * invoke on successful startup.
 */
function MailUniverse(callAfterBigBang, online, testOptions) {
  logic.defineScope(this, 'Universe');
  dump('=====================\n');
  // XXX proper logging configuration again once things start working
  // XXX XXX XXX XXX XXX XXX XXX
  logic.realtimeLogEverything = true;
  slog.setSensitiveDataLoggingEnabled(true);

  this.db = new MailDB(testOptions);

  this.accountsTOC = new AccountsTOC();
  this._residentAccountsById = new Map();
  this._loadingAccountsById = new Map();

  /** @type{Map<AccountId, FoldersTOC>} */
  this.accountFoldersTOCs = new Map();

  this._bridges = [];

  /** @type{Map<FolderId, FolderConversationsTOC>} */
  this._folderConvsTOCs = new Map();

  /** @type{Map<ConverastionId, ConversationTOC>} */
  this._conversationTOCs = new Map();

  this.taskManager = new TaskManager(this, this.db);

  /** Fake navigator to use for navigator.onLine checks */
  this._testModeFakeNavigator = (testOptions && testOptions.fakeNavigator) ||
                                null;

  // We used to try and use navigator.connection, but it's not supported on B2G,
  // so we have to use navigator.onLine like suckers.
  this.online = true; // just so we don't cause an offline->online transition
  // Events for online/offline are now pushed into us externally.  They need
  // to be bridged from the main thread anyways, so no point faking the event
  // listener.
  this._onConnectionChange(online);

  // Track the mode of the universe. Values are:
  // 'cron': started up in background to do tasks like sync.
  // 'interactive': at some point during its life, it was used to
  // provide functionality to a user interface. Once it goes
  // 'interactive', it cannot switch back to 'cron'.
  this._mode = 'cron';

  this.config = null;
  this._logReaper = null;
  this._logBacklog = null;

  this._LOG = null;
  //this._cronSync = null;
  this.db.getConfig((configObj, accountInfos, lazyCarryover) => {
    let setupLogging = (config) => {
      if (!config) {
        return;
      }
      if (config.debugLogging) {
        if (config.debugLogging === 'realtime-dangerous' ||
            config.debugLogging === 'dangerous') {
          console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
          console.warn('DANGEROUS USER-DATA ENTRAINING LOGGING ENABLED !!!');
          console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
          console.warn('This means contents of e-mails and passwords if you');
          console.warn('set up a new account.  (The IMAP protocol sanitizes');
          console.warn('passwords, but the bridge logger may not.)');
          console.warn('');
          console.warn('If you forget how to turn us off, see:');
          console.warn('https://wiki.mozilla.org/Gaia/Email/SecretDebugMode');
          console.warn('...................................................');
          logic.realtimeLogEverything();
          slog.setSensitiveDataLoggingEnabled(true);
        }
      }
    };

    let accountCount = accountInfos.length;
    if (configObj) {
      this.config = configObj;
      setupLogging(this.config);

      logic(this, 'configLoaded', { config: configObj });

      if (accountCount) {
        for (let i = 0; i < accountCount; i++) {
          let accountInfo = accountInfos[i];
          this._accountExists(accountInfo.def, accountInfo.folderInfo);
        }

        this._initFromConfig();
        callAfterBigBang(this);
        return;
      }
    }
    else {
      this.config = {
        // We need to put the id in here because our startup query can't
        // efficiently get both the key name and the value, just the values.
        id: 'config',
        nextAccountNum: 0,
        nextIdentityNum: 0,
        debugLogging: lazyCarryover ? lazyCarryover.config.debugLogging : false
      };
      setupLogging(this.config);
      this.db.saveConfig(this.config);

      // - Try to re-create any accounts using old account infos.
      if (lazyCarryover) {
        logic(this, 'migratingConfig:begin', { _lazyCarryOver: lazyCarryover });
        var waitingCount = lazyCarryover.accountInfos.length;
        var oldVersion = lazyCarryover.oldVersion;

        var accountRecreated = function(accountInfo, err) {
          logic(this, 'recreateAccount:end',
                { type: accountInfo.type,
                  id: accountInfo.id,
                  error: err });
          // We don't care how they turn out, just that they get a chance
          // to run to completion before we call our bootstrap complete.
          if (--waitingCount === 0) {
            logic(this, 'migratingConfig:end', {});
            this._initFromConfig();
            callAfterBigBang();
          }
        };

        for (let i = 0; i < lazyCarryover.accountInfos.length; i++) {
          let accountInfo = lazyCarryover.accountInfos[i];
          logic(this, 'recreateAccount:begin',
                { type: accountInfo.type,
                  id: accountInfo.id,
                  error: null });
          $acctcommon.recreateAccount(
            this, oldVersion, accountInfo,
            accountRecreated.bind(this, accountInfo));
        }
        // Do not let callAfterBigBang get called.
        return;
      }
      else {
        logic(this, 'configCreated', { config: this.config });
      }
    }
    this._initFromConfig();
    callAfterBigBang(this);
    return;
  });

  this.db.on('accounts!tocChange', this._onAccountRemoved.bind(this));
}
MailUniverse.prototype = {
  //////////////////////////////////////////////////////////////////////////////
  // Config / Settings

  /**
   * Perform initial initialization based on our configuration.
   */
  _initFromConfig: function() {
    this.taskManager.__restoreFromDB();

    // XXX disabled cronsync because of massive rearchitecture
    //this._cronSync = new $cronsync.CronSync(this, this._LOG);
  },

  /**
   * Return the subset of our configuration that the client can know about.
   */
  exposeConfigForClient: function() {
    // eventually, iterate over a whitelist, but for now, it's easy...
    return {
      debugLogging: this.config.debugLogging
    };
  },

  modifyConfig: function(changes) {
    for (var key in changes) {
      var val = changes[key];
      switch (key) {
        case 'debugLogging':
          break;
        default:
          continue;
      }
      this.config[key] = val;
    }
    this.db.saveConfig(this.config);
    this.__notifyConfig();
  },

  __notifyConfig: function() {
    var config = this.exposeConfigForClient();
    for (var iBridge = 0; iBridge < this._bridges.length; iBridge++) {
      var bridge = this._bridges[iBridge];
      bridge.notifyConfig(config);
    }
  },

  setInteractive: function() {
    this._mode = 'interactive';
  },

  //////////////////////////////////////////////////////////////////////////////
  _onConnectionChange: function(isOnline) {
    var wasOnline = this.online;
    /**
     * Are we online?  AKA do we have actual internet network connectivity.
     * This should ideally be false behind a captive portal.  This might also
     * end up temporarily false if we move to a 2-phase startup process.
     */
    this.online = this._testModeFakeNavigator ?
                    this._testModeFakeNavigator.onLine : isOnline;
    // Knowing when the app thinks it is online/offline is going to be very
    // useful for our console.log debug spew.
    console.log('Email knows that it is:', this.online ? 'online' : 'offline',
                'and previously was:', wasOnline ? 'online' : 'offline');
    /**
     * Do we want to minimize network usage?  Right now, this is the same as
     * metered, but it's conceivable we might also want to set this if the
     * battery is low, we want to avoid stealing network/cpu from other
     * apps, etc.
     *
     * NB: We used to get this from navigator.connection.metered, but we can't
     * depend on that.
     */
    this.minimizeNetworkUsage = true;
    /**
     * Is there a marginal cost to network usage?  This is intended to be used
     * for UI (decision) purposes where we may want to prompt before doing
     * things when bandwidth is metered, but not when the user is on comparably
     * infinite wi-fi.
     *
     * NB: We used to get this from navigator.connection.metered, but we can't
     * depend on that.
     */
    this.networkCostsMoney = true;

    // - Transition to online
    if (!wasOnline && this.online) {
      // XXX put stuff back in here
    }
  },

  registerBridge: function(mailBridge) {
    this._bridges.push(mailBridge);
  },

  unregisterBridge: function(mailBridge) {
    var idx = this._bridges.indexOf(mailBridge);
    if (idx !== -1) {
      this._bridges.splice(idx, 1);
    }
  },

  //////////////////////////////////////////////////////////////////////////////
  // Resource Acquisition stuff

  /**
   * Acquire an account.
   */
  acquireAccount: function(ctx, accountId) {
    if (this._residentAccountsById.has(accountId)) {
      // If the account is already loaded, acquire it immediately.
      let account = this._residentAccountsById.get(accountId);
      return ctx.acquire(account);
    } else if (this._loadingAccountsById.has(accountId)) {
      // It's loading; wait on the promise and acquire it when the promise is
      // resolved.
      return this._loadingAccountsById.get(accountId).then((account) => {
        return ctx.acquire(account);
      });
    } else {
      // We need to trigger loading it ourselves and then help
      let accountDef = this.accountsTOC.accountDefsById.get(accountId);
      if (!accountDef) {
        throw new Error('No accountDef with id: ' + accountId);
      }
      let foldersTOC = this.accountFoldersTOCs.get(accountId);
      return this._loadAccount(accountDef, foldersTOC, null).then((account) => {
        return ctx.acquire(account);
      });
      // (_loadAccount puts the promise in _loadingAccountsByID and clears it
      // when it finishes)
    }
  },

  /**
   * Acquire an account's folders TOC.
   *
   * Note that folderTOC's are eternal and so don't actually need reference
   * counting, etc.  However, we conform to the idiom.
   */
  acquireAccountFoldersTOC: function(ctx, accountId) {
    let foldersTOC = this.accountFoldersTOCs.get(accountId);
    if (!foldersTOC) {
      throw new Error('Account ' + accountId + ' lacks a foldersTOC!');
    }
    return Promise.resolve(foldersTOC);
  },

  acquireFolderConversationsTOC: function(ctx, folderId) {
    let toc;
    if (this._folderConvsTOCs.has(folderId)) {
      toc = this._folderConvsTOCs.get(folderId);
    } else {
      toc = new FolderConversationsTOC(this.db, folderId);
      this._folderConvsTOCs.set(folderId, toc);
      // TODO: have some means of the TOC to tell us to forget about it when
      // it gets released.
    }
    return ctx.acquire(toc);
  },

  acquireConversationTOC: function(ctx, conversationId) {
    let toc;
    if (this._conversationTOCs.has(conversationId)) {
      toc = this._conversationTOCs.get(conversationId);
    } else {
      toc = new ConversationTOC(this.db, conversationId);
      this._conversationTOCs.set(conversationId, toc);
      // TODO: have some means of the TOC to tell us to forget about it when
      // it gets released.
    }
    return ctx.acquire(toc);
  },

  //////////////////////////////////////////////////////////////////////////////

  learnAboutAccount: function(details) {
    var configurator = new $acctcommon.Autoconfigurator();
    return configurator.learnAboutAccount(details);
  },

  /**
   * Return a Promise that gets resolved with { error, errorDetails, accountId,
   * account}. "error" will be null if there's no problem and everything else
   * may potentially be undefined.
   *
   * TODO: Currently on success this bottoms out in a call to saveAccountDef
   * and we return the value it formulates.  While the promise-ification of
   * accountcommon and the configurators has cleaned things up slightly, it's
   * still pretty convoluted overall.  Probably good to task-ify the
   * configurator logic.
   */
  tryToCreateAccount: function mu_tryToCreateAccount(userDetails, domainInfo,
                                                     callback) {
    if (!this.online) {
      return Promise.resolve({ error: 'offline' });
    }
    // TODO: put back in detecting and refusing to create duplicate accounts.

    if (domainInfo) {
      return $acctcommon.tryToManuallyCreateAccount(
        this, userDetails, domainInfo);
    }
    else {
      // XXX: store configurator on this object so we can abort the connections
      // if necessary.
      var configurator = new $acctcommon.Autoconfigurator();
      return configurator.tryToCreateAccount(this, userDetails, callback);
    }
  },

  /**
   * Shutdown the account, forget about it, nuke associated database entries.
   */
  deleteAccount: function(accountId, why) {
    this.taskManager.scheduleTasks([
      {
        type: 'delete_account',
        accountId: accountId
      }
    ], why);
  },

  saveAccountDef: function(accountDef, folderDbState, protoConn, callback) {
    this.db.saveAccountDef(this.config, accountDef, folderDbState, callback);

    if (this.accountsTOC.isKnownAccount(accountDef.id)) {
      // XXX actually this should exclusively go through the database emitter
      // stuff.
      this.accountsTOC.accountModified(accountDef);
    } else {
      // (this happens during intial account (re-)creation)
      let accountWireRep = this._accountExists(accountDef, folderDbState);
      // If we were given a connection, instantiate the account so it can use
      // it.  Note that there's no potential for races at this point since no
      // one knows about this account until we return.
      if (protoConn) {
        return this._loadAccount(
          accountDef,
          this.accountFoldersTOCs.get(accountDef.id),
          protoConn)
        .then((account) => {
          return {
            error: null,
            errorDetails: null,
            accountId: accountDef.id,
            accountWireRep: accountWireRep
          };
        });
      }
    }
  },

  /**
   * Call this to tell the AccountsTOC about the existence of an account and
   * create/remember the corresponding FoldersTOC.  This does not load the
   * account.
   *
   * Returns the wireRep for the added account for the horrible benefit of
   * saveAccountDef and the legacy MailAPI tryTocreateAccount signature.
   */
  _accountExists: function(accountDef, folderInfo) {
    logic(this, 'accountExists', { accountId: accountDef.id });
    let foldersTOC = new FoldersTOC(folderInfo);
    this.accountFoldersTOCs.set(accountDef.id, foldersTOC);
    return this.accountsTOC.addAccount(accountDef);
  },

  /**
   * Translate a notification from MailDB that an account has been removed to
   * a call to the AccountsTOC to notify it and clean-up the associated
   * FoldersTOC instance.
   */
  _onAccountRemoved: function(accountId, accountDef) {
    // We're actually subscribed to a TOC change; bail if the account isn't
    // actually being removed.
    if (accountDef) {
      return;
    }

    let cleanupLiveAccount = (account) => {
      this._residentAccountsById.delete(accountId);
      account.shutdown();
    };

    if (this._residentAccountsById.has(accountId)) {
      let account = this._residentAccountsById.get(accountId);
      cleanupLiveAccount(account);
    } else if (this._loadingAccountsById.has(accountId)) {
      this._loadAccountsById.get(accountId).then(cleanupLiveAccount);
    }

    this.accountsTOC.removeAccountById(accountId);
    this.accountFoldersTOCs.delete(accountId);
  },

  /**
   * Instantiate an account from the persisted representation.
   * Asynchronous. Calls callback with the account object.
   */
  _loadAccount: function (accountDef, foldersTOC, receiveProtoConn) {
    let promise = new Promise((resolve, reject) => {
      $acctcommon.accountTypeToClass(accountDef.type, (constructor) => {
        if (!constructor) {
          logic(this, 'badAccountType', { type: accountDef.type });
          return;
        }
        let account = new constructor(this, accountDef, foldersTOC, this.db,
                                      receiveProtoConn);

        this._loadingAccountsById.delete(accountDef.id);
        this._residentAccountsById.set(accountDef.id, account);

        // - issue a (non-persisted) syncFolderList if needed
        let timeSinceLastFolderSync =
          Date.now() - account.meta.lastFolderSyncAt;
        if (timeSinceLastFolderSync >= $syncbase.SYNC_FOLDER_LIST_EVERY_MS) {
          this.syncFolderList(accountDef.id, 'loadAccount');
        }

        resolve(account);
      });
    });
    this._loadingAccountsById.set(accountDef.id, promise);
    return promise;
  },

  /**
   * Self-reporting by an account that it is experiencing difficulties.
   *
   * We mutate its state for it, and generate a notification if this is a new
   * problem.  For problems that require user action, we additionally generate
   * a bad login notification.
   *
   * @param account
   * @param {string} problem
   * @param {'incoming'|'outgoing'} whichSide
   */
  __reportAccountProblem: function(account, problem, whichSide) {
    // XXX make work again via overlays or something
    return;

    var suppress = false;
    // nothing to do if the problem is already known
    if (account.problems.indexOf(problem) !== -1) {
      suppress = true;
    }
    logic(this, 'reportProblem',
          { problem: problem, suppress: suppress, accountId: account.id });
    if (suppress) {
      return;
    }

    account.problems.push(problem);
    account.enabled = false;

    this.__notifyModifiedAccount(account);

    switch (problem) {
      case 'bad-user-or-pass':
      case 'needs-oauth-reauth':
      case 'bad-address':
      case 'imap-disabled':
        this.__notifyBadLogin(account, problem, whichSide);
        break;
    }
  },

  __removeAccountProblem: function(account, problem) {
    // XXX make work again
    return;
    var idx = account.problems.indexOf(problem);
    if (idx === -1)
      return;
    account.problems.splice(idx, 1);
    account.enabled = (account.problems.length === 0);

    this.__notifyModifiedAccount(account);

    if (account.enabled)
      this._resumeOpProcessingForAccount(account);
  },

  clearAccountProblems: function(account) {
    // XXX make work again
    return;
    logic(this, 'clearAccountProblems', { accountId: account.id });
    // TODO: this would be a great time to have any slices that had stalled
    // syncs do whatever it takes to make them happen again.
    account.enabled = true;
    account.problems = [];
    this._resumeOpProcessingForAccount(account);
  },

  //////////////////////////////////////////////////////////////////////////////
  // Lifetime Stuff

  /**
   * Shutdown all accounts; this is currently for the benefit of unit testing.
   * We expect our app to operate in a crash-only mode of operation where a
   * clean shutdown means we get a heads-up, put ourselves offline, and trigger a
   * state save before we just demand that our page be closed.  That's future
   * work, of course.
   *
   * If a callback is provided, a cleaner shutdown will be performed where we
   * wait for all current IMAP connections to be be shutdown by the server
   * before invoking the callback.
   */
  shutdown: function(callback) {
    var waitCount = this.accounts.length;
    // (only used if a 'callback' is passed)
    function accountShutdownCompleted() {
      if (--waitCount === 0)
        callback();
    }
    for (var iAcct = 0; iAcct < this.accounts.length; iAcct++) {
      var account = this.accounts[iAcct];
      // only need to pass our handler if clean shutdown is desired
      account.shutdown(callback ? accountShutdownCompleted : null);
    }

    if (this._cronSync) {
      this._cronSync.shutdown();
    }
    this.db.close();

    if (!this.accounts.length)
      callback();
  },

  syncFolderList: function(accountId, why) {
    this.taskManager.scheduleTasks([
      {
        type: 'sync_folder_list',
        accountId: accountId
      }
    ], why);
  },

  syncGrowFolder: function(folderId, why) {
    let accountId = folderId.split(/\./g)[0];
    this.taskManager.scheduleTasks([
      {
        type: 'sync_grow',
        accountId: accountId,
        folderId: folderId
      }
    ], why);
  },

  syncRefreshFolder: function(folderId, why) {
    let accountId = folderId.split(/\./g)[0];
    this.taskManager.scheduleTasks([
      {
        type: 'sync_refresh',
        accountId: accountId,
        folderId: folderId
      }
    ], why);
  },

  /**
   * Download entire bodyRep(s) representation.
   */
  downloadMessageBodyReps: function(suid, date, callback) {
    var account = this.getAccountForMessageSuid(suid);
    this._queueAccountOp(
      account,
      {
        type: 'downloadBodyReps',
        longtermId: 'session',
        lifecycle: 'do',
        localStatus: 'done',
        serverStatus: null,
        tryCount: 0,
        humanOp: 'downloadBodyReps',
        messageSuid: suid,
        messageDate: date
      },
      callback
    );
  },

  downloadBodies: function(messages, options, callback) {
    if (typeof(options) === 'function') {
      callback = options;
      options = null;
    }

    var self = this;
    var pending = 0;

    function next() {
      if (!--pending) {
        callback();
      }
    }
    this._partitionMessagesByAccount(messages, null).forEach(function(x) {
      pending++;
      self._queueAccountOp(
        x.account,
        {
          type: 'downloadBodies',
          longtermId: 'session', // don't persist this job.
          lifecycle: 'do',
          localStatus: 'done',
          serverStatus: null,
          tryCount: 0,
          humanOp: 'downloadBodies',
          messages: x.messages,
          options: options
        },
        next
      );
    });
  },

  /**
   * Download one or more related-part or attachments from a message.
   * Attachments are named by their index because the indices are stable and
   * flinging around non-authoritative copies of the structures might lead to
   * some (minor) confusion.
   *
   * This request is persistent although the callback will obviously be
   * discarded in the event the app is killed.
   *
   * @param {String[]} relPartIndices
   *     The part identifiers of any related parts to be saved to IndexedDB.
   * @param {String[]} attachmentIndices
   *     The part identifiers of any attachment parts to be saved to
   *     DeviceStorage.  For each entry in this array there should be a
   *     corresponding boolean in registerWithDownloadManager.
   * @param {Boolean[]} registerAttachments
   *     An array of booleans corresponding to each entry in attachmentIndices
   *     indicating whether the download should be registered with the download
   *     manager.
   */
  downloadMessageAttachments: function(messageSuid, messageDate,
                                       relPartIndices, attachmentIndices,
                                       registerAttachments,
                                       callback) {
    var account = this.getAccountForMessageSuid(messageSuid);
    var longtermId = this._queueAccountOp(
      account,
      {
        type: 'download',
        longtermId: null,
        lifecycle: 'do',
        localStatus: null,
        serverStatus: null,
        tryCount: 0,
        humanOp: 'download',
        messageSuid: messageSuid,
        messageDate: messageDate,
        relPartIndices: relPartIndices,
        attachmentIndices: attachmentIndices,
        registerAttachments: registerAttachments
      },
      callback);
  },

  modifyMessageTags: function(humanOp, messageSuids, addTags, removeTags) {
    var self = this, longtermIds = [];
    this._partitionMessagesByAccount(messageSuids, null).forEach(function(x) {
      this._taskManager.scheduleTask({

      });
      var longtermId = self._queueAccountOp(
        x.account,
        {
          type: 'modtags',
          longtermId: null,
          lifecycle: 'do',
          localStatus: null,
          serverStatus: null,
          tryCount: 0,
          humanOp: humanOp,
          messages: x.messages,
          addTags: addTags,
          removeTags: removeTags,
          // how many messages have had their tags changed already.
          progress: 0,
        });
      longtermIds.push(longtermId);
    }.bind(this));
    return longtermIds;
  },

  moveMessages: function(messageSuids, targetFolderId, callback) {
    var self = this, longtermIds = [],
        targetFolderAccount = this.getAccountForFolderId(targetFolderId);
    var latch = $allback.latch();
    this._partitionMessagesByAccount(messageSuids, null).forEach(function(x,i) {
      // TODO: implement cross-account moves and then remove this constraint
      // and instead schedule the cross-account move.
      if (x.account !== targetFolderAccount) {
        throw new Error('cross-account moves not currently supported!');
      }

      // If the move is entirely local-only (i.e. folders that will
      // never be synced to the server), we don't need to run the
      // server side of the job.
      //
      // When we're moving a message between an outbox and
      // localdrafts, we need the operation to succeed even if we're
      // offline, and we also need to receive the "moveMap" returned
      // by the local side of the operation, so that the client can
      // call "editAsDraft" on the moved message.
      //
      // TODO: When we have server-side 'draft' folder support, we
      // actually still want to run the server side of the operation,
      // but we won't want to wait for it to complete. Maybe modify
      // the job system to pass back localResult and serverResult
      // independently, or restructure the way we move outbox messages
      // back to the drafts folder.
      var targetStorage =
            targetFolderAccount.getFolderStorageForFolderId(targetFolderId);

      // If any of the sourceStorages (or targetStorage) is not
      // local-only, we can stop looking.
      var isLocalOnly = targetStorage.isLocalOnly;
      for (var j = 0; j < x.messages.length && isLocalOnly; j++) {
        var sourceStorage =
              self.getFolderStorageForMessageSuid(x.messages[j].suid);
        if (!sourceStorage.isLocalOnly) {
          isLocalOnly = false;
        }
      }

      var longtermId = self._queueAccountOp(
        x.account,
        {
          type: 'move',
          longtermId: null,
          lifecycle: 'do',
          localStatus: null,
          serverStatus: isLocalOnly ? 'n/a' : null,
          tryCount: 0,
          humanOp: 'move',
          messages: x.messages,
          targetFolder: targetFolderId,
        }, latch.defer(i));
      longtermIds.push(longtermId);
    });

    // When the moves finish, they'll each pass back results of the
    // form [err, moveMap]. The moveMaps provide a mapping of
    // sourceSuid => targetSuid, allowing the client to point itself
    // to the moved messages. Since multiple moves would result in
    // multiple moveMap results, we combine them here into a single
    // result map.
    latch.then(function(results) {
      // results === [[err, moveMap], [err, moveMap], ...]
      var combinedMoveMap = {};
      for (var key in results) {
        var moveMap = results[key][1];
        for (var k in moveMap) {
          combinedMoveMap[k] = moveMap[k];
        }
      }
      callback && callback(/* err = */ null, /* result = */ combinedMoveMap);
    });
    return longtermIds;
  },

  deleteMessages: function(messageSuids) {
    var self = this, longtermIds = [];
    this._partitionMessagesByAccount(messageSuids, null).forEach(function(x) {
      var longtermId = self._queueAccountOp(
        x.account,
        {
          type: 'delete',
          longtermId: null,
          lifecycle: 'do',
          localStatus: null,
          serverStatus: null,
          tryCount: 0,
          humanOp: 'delete',
          messages: x.messages
        });
      longtermIds.push(longtermId);
    });
    return longtermIds;
  },

  /**
   * APPEND messages to an IMAP server without locally saving the messages.
   * This was originally an IMAP testing operation that was co-opted to be
   * used for saving sent messages in a corner-cutting fashion.  (The right
   * thing for us to do would be to save the message locally too and deal with
   * the UID implications.  But that is tricky.)
   *
   * See ImapAccount.saveSentMessage for more context.
   *
   * POP3's variation on this is saveSentDraft
   */
  appendMessages: function(folderId, messages, callback) {
    var account = this.getAccountForFolderId(folderId);
    var longtermId = this._queueAccountOp(
      account,
      {
        type: 'append',
        // Don't persist.  See ImapAccount.saveSentMessage for our rationale.
        longtermId: 'session',
        lifecycle: 'do',
        localStatus: 'done',
        serverStatus: null,
        tryCount: 0,
        humanOp: 'append',
        messages: messages,
        folderId: folderId,
      },
      callback);
    return [longtermId];
  },

  /**
   * Save a sent POP3 message to the account's "sent" folder.  See
   * Pop3Account.saveSentMessage for more information.
   *
   * IMAP's variation on this is appendMessages.
   *
   * @param folderId {FolderID}
   * @param sentSafeHeader {HeaderInfo}
   *   The header ready to be added to the sent folder; suid issued and
   *   everything.
   * @param sentSafeBody {BodyInfo}
   *   The body ready to be added to the sent folder; attachment blobs stripped.
   * @param callback {function(err)}
   */
  saveSentDraft: function(folderId, sentSafeHeader, sentSafeBody, callback) {
    var account = this.getAccountForMessageSuid(sentSafeHeader.suid);
    var longtermId = this._queueAccountOp(
      account,
      {
        type: 'saveSentDraft',
        // we can persist this since we have stripped the blobs
        longtermId: null,
        lifecycle: 'do',
        localStatus: null,
        serverStatus: 'n/a',
        tryCount: 0,
        humanOp: 'saveSentDraft',
        folderId: folderId,
        headerInfo: sentSafeHeader,
        bodyInfo: sentSafeBody
      },
      callback);
    return [longtermId];
  },

  /**
   * Process the given attachment blob in slices into base64-encoded Blobs
   * that we store in IndexedDB (currently).  This is a local-only operation.
   *
   * This function is implemented as a job/operation so it is inherently ordered
   * relative to other draft-related calls.  But do keep in mind that you need
   * to make sure to not destroy the underlying storage for the Blob (ex: when
   * using DeviceStorage) until the callback has fired.
   */
  attachBlobToDraft: function(account, existingNamer, attachmentDef, callback) {
    this._queueAccountOp(
      account,
      {
        type: 'attachBlobToDraft',
        // We don't persist the operation to disk in order to avoid having the
        // Blob we are attaching get persisted to IndexedDB.  Better for the
        // disk I/O to be ours from the base64 encoded writes we do even if
        // there is a few seconds of data-loss-ish vulnerability.
        longtermId: 'session',
        lifecycle: 'do',
        localStatus: null,
        serverStatus: 'n/a', // local-only currently
        tryCount: 0,
        humanOp: 'attachBlobToDraft',
        existingNamer: existingNamer,
        attachmentDef: attachmentDef
      },
      callback
    );
  },

  /**
   * Remove an attachment from a draft.  This will not interrupt an active
   * attaching operation or moot a pending one.  This is a local-only operation.
   */
  detachAttachmentFromDraft: function(account, existingNamer, attachmentIndex,
                                      callback) {
    this._queueAccountOp(
      account,
      {
        type: 'detachAttachmentFromDraft',
        // This is currently non-persisted for symmetry with attachBlobToDraft
        // but could be persisted if we wanted.
        longtermId: 'session',
        lifecycle: 'do',
        localStatus: null,
        serverStatus: 'n/a', // local-only currently
        tryCount: 0,
        humanOp: 'detachAttachmentFromDraft',
        existingNamer: existingNamer,
        attachmentIndex: attachmentIndex
      },
      callback
    );
  },

  /**
   * Save a new (local) draft or update an existing (local) draft.  A new namer
   * is synchronously created and returned which will be the name for the draft
   * assuming the save completes successfully.
   *
   * This function is implemented as a job/operation so it is inherently ordered
   * relative to other draft-related calls.
   *
   * @method saveDraft
   * @param account
   * @param [existingNamer] {MessageNamer}
   * @param draftRep
   * @param callback {Function}
   * @return {MessageNamer}
   *
   */
  saveDraft: function(account, existingNamer, draftRep, callback) {
    var draftsFolderMeta = account.getFirstFolderWithType('localdrafts');
    var draftsFolderStorage = account.getFolderStorageForFolderId(
                                draftsFolderMeta.id);
    var newId = draftsFolderStorage._issueNewHeaderId();
    var newDraftInfo = {
      id: newId,
      suid: draftsFolderStorage.folderId + '.' + newId,
      // There are really 3 possible values we could use for this; when the
      // front-end initiates the draft saving, when we, the back-end observe and
      // enqueue the request (now), or when the draft actually gets saved to
      // disk.
      //
      // This value does get surfaced to the user, so we ideally want it to
      // occur within a few seconds of when the save is initiated.  We do this
      // here right now because we have access to $date, and we should generally
      // be timely about receiving messages.
      date: $date.NOW(),
    };
    this._queueAccountOp(
      account,
      {
        type: 'saveDraft',
        longtermId: null,
        lifecycle: 'do',
        localStatus: null,
        serverStatus: 'n/a', // local-only currently
        tryCount: 0,
        humanOp: 'saveDraft',
        existingNamer: existingNamer,
        newDraftInfo: newDraftInfo,
        draftRep: draftRep,
      },
      callback
    );
    return {
      suid: newDraftInfo.suid,
      date: newDraftInfo.date
    };
  },

  /**
   * Kick off a job to send pending outgoing messages. See the job
   * documentation regarding "sendOutboxMessages" for more details.
   *
   * @param {MailAccount} account
   * @param {MessageNamer} opts.beforeMessage
   *   If provided, start with the first message older than this one.
   *   (This is only used internally within the job itself.)
   * @param {string} opts.reason
   *   Optional description, used for debugging.
   * @param {Boolean} opts.emitNotifications
   *   True to pass along send status notifications to the model.
   */
  sendOutboxMessages: function(account, opts, callback) {
    opts = opts || {};

    console.log('outbox: sendOutboxMessages(', JSON.stringify(opts), ')');

    // If we are not online, we won't actually kick off a job until we
    // come back online. Immediately fire a status notification
    // indicating that we are done attempting to sync for now.
    if (!this.online) {
      this.notifyOutboxSyncDone(account);
      // Fall through; we still want to queue the op.
    }

    // Do not attempt to check if the outbox is empty here. This op is
    // queued immediately after the client moves a message to the
    // outbox. The outbox may be empty here, but it might be filled
    // when the op runs.
    this._queueAccountOp(
      account,
      {
        type: 'sendOutboxMessages',
        longtermId: 'session', // Does not need to be persisted.
        lifecycle: 'do',
        localStatus: 'n/a',
        serverStatus: null,
        tryCount: 0,
        beforeMessage: opts.beforeMessage,
        emitNotifications: opts.emitNotifications,
        humanOp: 'sendOutboxMessages'
      },
      callback);
  },

  /**
   * Dispatch a notification to the frontend, indicating that we're
   * done trying to send messages from the outbox for now.
   */
  notifyOutboxSyncDone: function(account) {
    this.__notifyBackgroundSendStatus({
      accountId: account.id,
      state: 'syncDone'
    });
  },

  /**
   * Enable or disable Outbox syncing temporarily. For instance, you
   * will want to disable outbox syncing if the user is in "edit mode"
   * for the list of messages in the outbox folder. This setting does
   * not persist.
   */
  setOutboxSyncEnabled: function(account, enabled, callback) {
    this._queueAccountOp(
      account,
      {
        type: 'setOutboxSyncEnabled',
        longtermId: 'session', // Does not need to be persisted.
        lifecycle: 'do',
        localStatus: null,
        serverStatus: 'n/a', // Local-only.
        outboxSyncEnabled: enabled,
        tryCount: 0,
        humanOp: 'setOutboxSyncEnabled'
      },
      callback);
  },

  /**
   * Delete an existing (local) draft.
   *
   * This function is implemented as a job/operation so it is inherently ordered
   * relative to other draft-related calls.
   */
  deleteDraft: function(account, messageNamer, callback) {
    this._queueAccountOp(
      account,
      {
        type: 'deleteDraft',
        longtermId: null,
        lifecycle: 'do',
        localStatus: null,
        serverStatus: 'n/a', // local-only currently
        tryCount: 0,
        humanOp: 'deleteDraft',
        messageNamer: messageNamer
      },
      callback
    );

  },

  /**
   * Create a folder that is the child/descendant of the given parent folder.
   * If no parent folder id is provided, we attempt to create a root folder,
   * but honoring the server's configured personal namespace if applicable.
   *
   * @param [AccountId] accountId
   * @param {String} [parentFolderId]
   *   If null, place the folder at the top-level, otherwise place it under
   *   the given folder.
   * @param {String} folderName
   *   The (unencoded) name of the folder to be created.
   * @param {String} folderType
   *   The gelam folder type we should think of this folder as.  On servers
   *   supporting SPECIAL-USE we will attempt to set the metadata server-side
   *   as well.
   * @param {Boolean} containOtherFolders
   *   Should this folder only contain other folders (and no messages)?
   *   On some servers/backends, mail-bearing folders may not be able to
   *   create sub-folders, in which case one would have to pass this.
   * @param {Function(err, folderMeta)} callback
   *   A callback that gets called with the folderMeta of the successfully
   *   created folder or null if there was an error.  (The error code is also
   *   provided as the first argument.)
   * ]
   */
  createFolder: function(accountId, parentFolderId, folderName, folderType,
                         containOtherFolders, callback) {
    var account = this.getAccountForAccountId(accountId);
    var longtermId = this._queueAccountOp(
      account,
      {
        type: 'createFolder',
        longtermId: null,
        lifecycle: 'do',
        localStatus: null,
        serverStatus: null,
        tryCount: 0,
        humanOp: 'createFolder',
        parentFolderId: parentFolderId,
        folderName: folderName,
        folderType: folderType,
        containOtherFolders: containOtherFolders
      },
      callback);
    return [longtermId];
  },

  //////////////////////////////////////////////////////////////////////////////
};

return MailUniverse;
}); // end define

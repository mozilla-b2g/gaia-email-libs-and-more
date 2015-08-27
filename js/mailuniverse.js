define(function(require) {
'use strict';

let logic = require('logic');
let slog = require('./slog');
let $syncbase = require('./syncbase');
let MailDB = require('./maildb');
let $acctcommon = require('./accountcommon');
let $allback = require('./allback');

let AccountsTOC = require('./db/accounts_toc');
let FolderConversationsTOC = require('./db/folder_convs_toc');
let FoldersTOC = require('./db/folders_toc');
let ConversationTOC = require('./db/conv_toc');

let TaskManager = require('./task_manager');
let TaskRegistry = require('./task_registry');
let TaskPriorities = require('./task_priorities');
let TaskResources = require('./task_resources');

let globalTasks = require('./global_tasks');
// TODO: lazy-load these by mapping engine names to modules to dynamically
// require.
let gmailTasks = require('./imap/gmail_tasks');
let vanillaImapTasks = require('./imap/vanilla_tasks');
let activesyncTasks = require('./activesync/activesync_tasks');
let pop3Tasks = require('./pop3/pop3_tasks');

let { accountIdFromMessageId, accountIdFromConvId, convIdFromMessageId } =
  require('./id_conversions');

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

  this.taskRegistry = new TaskRegistry(this.db);
  this.taskPriorities = new TaskPriorities();
  this.taskResources = new TaskResources(this.taskPriorities);
  this.taskManager = new TaskManager({
    universe: this,
    db: this.db,
    registry: this.taskRegistry,
    resources: this.taskResources,
    priorities: this.taskPriorities,
    accountsTOC: this.accountsTOC
  });

  this.taskRegistry.registerGlobalTasks(globalTasks);
  // TODO: as noted above, these should really be doing lazy requires and
  // registration as accounts demand to be loaded.  (Note: not particularly
  // hard, but during current dev phase, we want to fail early, not lazily.)
  this.taskRegistry.registerPerAccountTypeTasks(
    'gmailImap', gmailTasks);
  this.taskRegistry.registerPerAccountTypeTasks(
    'vanillaImap', vanillaImapTasks);
  this.taskRegistry.registerPerAccountTypeTasks(
    'activesync', activesyncTasks);
  this.taskRegistry.registerPerAccountTypeTasks(
    'pop3', pop3Tasks);

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
   * Acquire an account's folders TOC.  If you don't want the account, just its
   * folders, use this.
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
  tryToCreateAccount: function(userDetails, domainInfo, callback) {
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

  /**
   * TODO: This and tryToCreateAccount should be refactored to properly be
   * tasks.
   */
  saveAccountDef: function(accountDef, folderDbState, protoConn, callback) {
    this.db.saveAccountDef(this.config, accountDef, folderDbState, callback);

    if (this.accountsTOC.isKnownAccount(accountDef.id)) {
      // TODO: actually this should exclusively go through the database emitter
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
        .then(() => {
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
    let promise = new Promise((resolve) => {
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
      if (--waitCount === 0) {
        callback();
      }
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

    if (!this.accounts.length) {
      callback();
    }
  },

  syncFolderList: function(accountId, why) {
    return this.taskManager.scheduleTasks([
      {
        type: 'sync_folder_list',
        accountId: accountId
      }
    ], why);
  },

  syncGrowFolder: function(folderId, why) {
    let accountId = folderId.split(/\./g)[0];
    return this.taskManager.scheduleTasks([
      {
        type: 'sync_grow',
        accountId: accountId,
        folderId: folderId
      }
    ], why);
  },

  syncRefreshFolder: function(folderId, why) {
    let accountId = folderId.split(/\./g)[0];
    return this.taskManager.scheduleTasks([
      {
        type: 'sync_refresh',
        accountId: accountId,
        folderId: folderId
      }
    ], why);
  },

  fetchConversationSnippets: function(convIds, why) {
    let tasks = convIds.map((convId) => {
      return {
        type: 'sync_body',
        accountId: accountIdFromConvId(convId),
        convId: convId,
        amount: 'snippet',
      };
    });
    return this.taskManager.scheduleTasks(tasks, why);
  },

  fetchMessageBody: function(messageId, messageDate, why) {
    return this.taskManager.scheduleTasks([
      {
        type: 'sync_body',
        accountId: accountIdFromMessageId(messageId),
        convId: convIdFromMessageId(messageId),
        fullBodyMessageIds: new Set([messageId])
      }
    ], why);
  },

  storeLabels: function(conversationId, messageIds, messageSelector, addLabels,
                        removeLabels) {
    return this.taskManager.scheduleTasks([
      {
        type: 'store_labels',
        accountId: accountIdFromConvId(conversationId),
        convId: conversationId,
        onlyMessages: messageIds || null,
        messageSelector: messageSelector || null,
        add: addLabels,
        remove: removeLabels
      }
    ]);
  },

  storeFlags: function(conversationId, messageIds, messageSelector, addFlags,
                       removeFlags) {
    return this.taskManager.scheduleTasks([
      {
        type: 'store_flags',
        accountId: accountIdFromConvId(conversationId),
        convId: conversationId,
        onlyMessages: messageIds || null,
        messageSelector: messageSelector || null,
        add: addFlags,
        remove: removeFlags
      }
    ]);
  },

  /**
   * Enqueue the planning of a task that creates a draft (either blank, reply,
   * or forward), returning a Promise that will be resolved with the MessageId
   * of the resulting draft and the ConversationId of the conversation to which
   * it belongs.
   *
   * The underlying creation task is non-persistent because draft creation is
   * an interactive, stateful task.  If the app crashes before the draft is
   * created, it's not guaranteed the user will go immediately try to resume
   * composing.  And if they do, they might not do so via our created draft, so
   * it's best to avoid creating the draft on app restart.  For now at least.
   */
  createDraft: function({ draftType, mode, refMessageId, refMessageDate,
                          folderId }) {
    return this.taskManager.scheduleNonPersistentTasks([
      {
        type: 'draft_create',
        draftType,
        mode,
        refMessageId,
        refMessageDate,
        folderId
      }
    ]).then((taskIds) => {
      return this.taskManager.waitForTasksToBePlanned(taskIds);
    }).then((results) => {
      // (Although the signatures support multiple tasks, we only issued one.)
      return results[0];
    });
  },

  attachBlobToDraft: function(messageId, attachmentDef) {
    // non-persistent because this is a local-only op and we don't want the
    // original stored in our database (at this time)
    return this.taskManager.scheduleNonPersistentTasks([{
      type: 'draft_attach',
      accountId: accountIdFromMessageId(messageId),
      messageId,
      attachmentDef
    }]);
  },

  detachAttachmentFromDraft: function(messageId, attachmentRelId) {
    // non-persistent for now because it would be awkward
    return this.taskManager.scheduleNonPersistentTasks([{
      type: 'draft_detach',
      accountId: accountIdFromMessageId(messageId),
      messageId,
      attachmentRelId
    }]);
  },

  /**
   * Update an existing draft.
   *
   * Unlike draft creation and blob attachment, this is a persisted task.
   * It's persisted because:
   * - We absolutely don't want to lose this user-authored data.
   * - The Blob sizes aren't too big.
   * - Our IndexedDB implementation allegedly has magic so that even if we don't
   *   write-then-read the blobs back-out immediately, the separate transaction
   *   writing the same Blob will still be stored using the same underlying
   *   reference-counted backing Blob.  So there's no harm.
   */
  saveDraft: function(messageId, draftFields) {
    return this.taskManager.scheduleTasks([{
      type: 'draft_save',
      accountId: accountIdFromMessageId(messageId),
      messageId,
      draftFields
    }]);
  },

  /**
   * Delete an existing (local) draft.  This may end up just using the normal
   * message deletion logic under the hood, but right now
   */
  deleteDraft: function(messageId) {
    return this.taskManager.scheduleTasks([{
      type: 'draft_delete',
      accountId: accountIdFromMessageId(messageId),
      messageId
    }]);
  },


  /**
   * Move a message from being a draft to being in the outbox, potentially
   * initiating the send if we're online.
   */
  outboxSendDraft: function(messageId) {
    return this.taskManager.scheduleTasks([{
      type: 'outbox_send',
      command: 'send',
      accountId: accountIdFromMessageId(messageId),
      messageId
    }]);
  },

  /**
   * Abort the sending of a message draft (if reliably possible), moving it back
   * to be a draft.
   */
  outboxAbortSend: function(messageId) {
    return this.taskManager.scheduleTasks([{
      type: 'outbox_send',
      command: 'abort',
      accountId: accountIdFromMessageId(messageId),
      messageId
    }]);
  },

  /**
   * Pause/unpause the outbox for an account.  The UI may want to pause the
   * outbox so that the user has a chance to cause `outboxAbortSend` to be
   * invoked before it's too late.  (If the user is frantically trying to
   * stop a message from getting sent, we want to give them a fighting chance.)
   */
  outboxSetPaused: function(accountId, bePaused) {
    return this.taskManager.scheduleTasks([{
      type: 'outbox_send',
      command: 'setPaused',
      accountId: accountId,
      pause: bePaused
    }]);
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
    // XXX OLD
  },

  modifyMessageTags: function(humanOp, messageSuids, addTags, removeTags) {
    // XXX OLD
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
   * Schedule a task to create a folder that is the child/descendant of the
   * given parent folder. If no parent folder id is provided, we attempt to
   * create a root folder, but honoring the server's configured personal
   * namespace if applicable.
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
   * ]
   */
  createFolder: function(accountId, parentFolderId, folderName, folderType,
                         containOtherFolders) {
    // XXX implement!
    return;
  },

  //////////////////////////////////////////////////////////////////////////////
};

return MailUniverse;
}); // end define

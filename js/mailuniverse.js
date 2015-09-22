define(function(require) {
'use strict';

const logic = require('logic');
const slog = require('./slog');
const MailDB = require('./maildb');

const AccountManager = require('./universe/account_manager');

const FolderConversationsTOC = require('./db/folder_convs_toc');
const ConversationTOC = require('./db/conv_toc');

const TaskManager = require('./task_infra/task_manager');
const TaskRegistry = require('./task_infra/task_registry');
const TaskPriorities = require('./task_infra/task_priorities');
const TaskResources = require('./task_infra/task_resources');

const TriggerManager = require('./db/trigger_manager');
const dbTriggerDefs = require('./db_triggers/all');

const globalTasks = require('./global_tasks');

const { accountIdFromMessageId, accountIdFromConvId, convIdFromMessageId } =
  require('./id_conversions');

/**
 * The root of the backend, coordinating/holding everything together.  It is the
 * API exposed to the `MailBridge`.  It also exposes resource-management related
 * APIs to tasks, although we might move most of that into `TaskContext`
 * especially as we push more of our implementation into helpers that live in
 * the `universe` subdirectory.
 */
function MailUniverse(online, testOptions) {
  logic.defineScope(this, 'Universe');
  this._initialized = false;

  this.db = new MailDB({
    universe: this,
    testOptions
  });

  this._bridges = [];


  /** @type{Map<FolderId, FolderConversationsTOC>} */
  this._folderConvsTOCs = new Map();

  /** @type{Map<ConverastionId, ConversationTOC>} */
  this._conversationTOCs = new Map();

  this.taskRegistry = new TaskRegistry();
  this.taskPriorities = new TaskPriorities();
  this.taskResources = new TaskResources(this.taskPriorities);

  this.accountManager = new AccountManager({
    db: this.db,
    universe: this,
    taskRegistry: this.taskRegistry
  });
  this.taskManager = new TaskManager({
    universe: this,
    db: this.db,
    registry: this.taskRegistry,
    resources: this.taskResources,
    priorities: this.taskPriorities,
    accountsTOC: this.accountManager.accountsTOC
  });
  this.triggerManager = new TriggerManager({
    db: this.db,
    triggers: dbTriggerDefs
  });

  this.taskRegistry.registerGlobalTasks(globalTasks);


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
}
MailUniverse.prototype = {
  /**
   * Initialize and configure logging.
   */
  _initLogging: function(config) {
    // Delimit different runs of the universe from each other in the cheapest
    // way possible.
    console.log('======================');
    // XXX proper logging configuration again once things start working
    // XXX XXX XXX XXX XXX XXX XXX
    logic.realtimeLogEverything = true;
    slog.setSensitiveDataLoggingEnabled(true);

    // XXX hack to skip the next logic without the linter.
    config = null;

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
  },

  /**
   * As part of initialization where we are doing a "lazy config carryover"
   * wherein we blew away the database because it was out-of-date enough for
   * us, create a "migration" task that will cause the account to be re-created.
   *
   * Note that this is currently a cop-out potentially data-lossy migration
   * mechanism.  See disclaimers elsewhere, but ideally this gets fancier in
   * the future.  Or we grow a separate more sophisticated mechanism.
   */
  _generateMigrationTasks: function({ accountDefs }) {
    return accountDefs.map((accountDef) => {
      return {
        type: 'account_migrate',
        accountDef
      };
    });
  },

  init: function() {
    if (this._initialized !== false) {
      throw new Error('misuse');
    }
    this._initialized = 'initializing';
    return this.db.getConfig().then(({ config, accountDefs, carryover }) => {
      if (config) {
        return this._initFromConfig({ config, accountDefs });
      }
      else {
        let freshConfig = {
          // (We store accounts and the config in the same table and we only
          // fetch values, not keys, so the config has to self-identify even if
          // it seems silly.)
          id: 'config',
          nextAccountNum: carryover ? carryover.config.nextAccountNum : 0,
          debugLogging: carryover ? carryover.config.debugLogging : false
        };
        let migrationTasks;
        if (carryover) {
          migrationTasks = this._generateMigrationTasks(carryover);
        }
        // (it returns a Promise for consistency, but we don't care.)
        this.db.saveConfig(freshConfig);

        return this._initFromConfig({
          config: freshConfig,
          accountDefs: [],
          tasksToPlan: migrationTasks
        });
      }
    });
  },

  //////////////////////////////////////////////////////////////////////////////
  // Config / Settings

  /**
   * Perform initial initialization based on our configuration.
   */
  _initFromConfig: function({ config, accountDefs, tasksToPlan }) {
    this._initialized = true;
    this.config = config;
    this._initLogging(config);
    logic(this, 'configLoaded', { config });

    // For reasons of sanity, we bring up the account manager (which is
    // responsible for registering tasks with the task registry as needed) in
    // its entirety before we initialize the TaskManager so it can assume all
    // task-type definitions are already loaded.
    return this.accountManager.initFromDB(accountDefs)
      .then(() => {
        return this.taskManager.__restoreFromDB();
      })
      .then(() => {
        if (tasksToPlan) {
          this.taskManager.scheduleTasks(tasksToPlan, 'initFromConfig');
        }
        return this;
      });

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
    // XXX OLD: this wants to be a task using atomicClobber functionality.
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

  acquireAccountsTOC: function(ctx) {
    return this.accountManager.acquireAccountsTOC(ctx);
  },

  /**
   * Acquire an account.
   */
  acquireAccount: function(ctx, accountId) {
    return this.accountManager.acquireAccount(ctx, accountId);
  },

  /**
   * Acquire an account's folders TOC.  If you don't want the account, just its
   * folders, use this.
   *
   * Note that folderTOC's are eternal and so don't actually need reference
   * counting, etc.  However, we conform to the idiom.
   */
  acquireAccountFoldersTOC: function(ctx, accountId) {
    return this.accountManager.acquireAccountFoldersTOC(ctx, accountId);
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

  learnAboutAccount: function(userDetails, why) {
    return this.taskManager.scheduleNonPersistentTaskAndWaitForExecutedResult(
      {
        type: 'account_autoconfig',
        userDetails
      },
      why);
  },

  /**
   * Return a Promise that gets resolved with { error, errorDetails,
   * accountId }. "error" will be null if there's no problem and everything else
   * may potentially be undefined.
   */
  tryToCreateAccount: function(userDetails, domainInfo, why) {
    if (!this.online) {
      return Promise.resolve({ error: 'offline' });
    }
    // TODO: put back in detecting and refusing to create duplicate accounts.

    if (domainInfo) {
      // -- Explicit creation
      return this.taskManager.scheduleNonPersistentTaskAndWaitForExecutedResult(
        {
          type: 'account_create',
          userDetails,
          domainInfo
        },
        why);
    } else {
      // -- Attempt autoconfig then chain into creation
      return this.taskManager.scheduleNonPersistentTaskAndWaitForExecutedResult(
        {
          type: 'account_autoconfig',
          userDetails
        },
        why)
      .then((result) => {
        // - If we got anything other than a need-password result, we failed.
        // Convert the "result" to an error.
        if (result.result !== 'need-password') {
          return {
            error: result.result,
            errorDetails: null
          };
        }
        // - Okay, try the account creation then.
        return this.taskManager.scheduleNonPersistentTaskAndWaitForExecutedResult(
          {
            type: 'account_create',
            userDetails,
            domainInfo: result.configInfo
          },
          why);
      });
    }
  },

  /**
   * Shutdown the account, forget about it, nuke associated database entries.
   */
  deleteAccount: function(accountId, why) {
    this.taskManager.scheduleTasks([
      {
        type: 'account_delete',
        accountId
      }
    ], why);
  },

  /**
   * TODO: This and tryToCreateAccount should be refactored to properly be
   * tasks.
   */
  saveAccountDef: function(accountDef, protoConn) {
    this.db.saveAccountDef(this.config, accountDef);

    if (this.accountsTOC.isKnownAccount(accountDef.id)) {
      // TODO: actually this should exclusively go through the database emitter
      // stuff.
      this.accountsTOC.accountModified(accountDef);
    } else {
      // (this happens during intial account (re-)creation)
      let accountWireRep = this._accountExists(accountDef);
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
                          folderId }, why) {
    return this.taskManager.scheduleNonPersistentTaskAndWaitForPlannedResult(
      {
        type: 'draft_create',
        draftType,
        mode,
        refMessageId,
        refMessageDate,
        folderId
      },
      why);
  },

  attachBlobToDraft: function(messageId, attachmentDef, why) {
    // non-persistent because this is a local-only op and we don't want the
    // original stored in our database (at this time)
    return this.taskManager.scheduleNonPersistentTasks([{
      type: 'draft_attach',
      accountId: accountIdFromMessageId(messageId),
      messageId,
      attachmentDef
    }], why);
  },

  detachAttachmentFromDraft: function(messageId, attachmentRelId, why) {
    // non-persistent for now because it would be awkward
    return this.taskManager.scheduleNonPersistentTasks([{
      type: 'draft_detach',
      accountId: accountIdFromMessageId(messageId),
      messageId,
      attachmentRelId
    }], why);
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
  saveDraft: function(messageId, draftFields, why) {
    return this.taskManager.scheduleTasks([{
      type: 'draft_save',
      accountId: accountIdFromMessageId(messageId),
      messageId,
      draftFields
    }], why);
  },

  /**
   * Delete an existing (local) draft.  This may end up just using the normal
   * message deletion logic under the hood, but right now
   */
  deleteDraft: function(messageId, why) {
    return this.taskManager.scheduleTasks([{
      type: 'draft_delete',
      accountId: accountIdFromMessageId(messageId),
      messageId
    }], why);
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

  moveMessages: function(messageSuids, targetFolderId, callback) {
    // XXX OLD
  },

  deleteMessages: function(messageSuids) {
    // XXX OLD
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

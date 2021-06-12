import logic from 'logic';
import MailDB from './maildb';


import AccountManager from './universe/account_manager';
import CronSyncSupport from './universe/cronsync_support';
import ExtensionManager from './universe/extension_manager';
import TOCManager from './universe/toc_manager';
import DerivedViewManager from './universe/derived_view_manager';

import DataOverlayManager from './db/data_overlay_manager';
import FolderConversationsTOC from './db/folder_convs_toc';
import ConversationTOC from './db/conv_toc';

import SyncLifecycleMetaHelper from './db/toc_meta/sync_lifecycle';

import TaskManager from './task_infra/task_manager';
import TaskRegistry from './task_infra/task_registry';
import TaskPriorities from './task_infra/task_priorities';
import TaskResources from './task_infra/task_resources';
import TaskGroupTracker from './task_infra/task_group_tracker';

import QueryManager from './search/query_manager';
import TriggerManager from './db/trigger_manager';
import dbTriggerDefs from './db_triggers/all';

import globalTasks from './global_tasks';

import { accountIdFromFolderId, accountIdFromMessageId, accountIdFromConvId,
        convIdFromMessageId, accountIdFromIdentityId } from
  'shared/id_conversions';

/**
 * The root of the backend, coordinating/holding everything together.  It is the
 * API exposed to the `MailBridge`.  It also exposes resource-management related
 * APIs to tasks, although we might move most of that into `TaskContext`
 * especially as we push more of our implementation into helpers that live in
 * the `universe` subdirectory.
 *
 * @constructor
 * @memberof module:mailuniverse
 */
export default function MailUniverse({ online, testOptions, appExtensions }) {
  logic.defineScope(this, 'Universe');
  this._initialized = false;
  this._appExtensions = appExtensions;

  // -- Initialize everything
  // We use locals here with the same name as instance variables in order to get
  // eslint to immediately tell us if we're being dumb with ordering when
  // passing arguments.  (Otherwise things could be undefined.)
  const db = this.db = new MailDB({
    universe: this,
    testOptions
  });

  const tocManager = this.tocManager = new TOCManager();
  const derivedViewManager = this.derivedViewManager = new DerivedViewManager();

  this.queryManager = new QueryManager({
    db,
    derivedViewManager
  });
  const triggerManager = this.triggerManager = new TriggerManager({
    db,
    triggers: dbTriggerDefs
  });

  this._bridges = [];


  /** @type{Map<FolderId, FolderConversationsTOC>} */
  this._folderConvsTOCs = new Map();

  /** @type{Map<FolderId, ConversationTOC>} */
  this._folderMessagesTOCs = new Map();

  /** @type{Map<ConversationId, ConversationTOC>} */
  this._conversationTOCs = new Map();

  const dataOverlayManager = this.dataOverlayManager = new DataOverlayManager();

  const taskPriorities = this.taskPriorities = new TaskPriorities();
  const taskResources = this.taskResources =
    new TaskResources(this.taskPriorities);
  const taskRegistry = this.taskRegistry = new TaskRegistry({
    dataOverlayManager,
    triggerManager,
    taskResources,
  });

  const accountManager = this.accountManager = new AccountManager({
    db,
    universe: this,
    taskRegistry,
    taskResources
  });
  const taskManager = this.taskManager = new TaskManager({
    universe: this,
    db,
    taskRegistry,
    taskResources,
    taskPriorities,
    accountManager
  });
  this.taskGroupTracker = new TaskGroupTracker(taskManager);

  this.taskRegistry.registerGlobalTasks(globalTasks);

  /**
   * This gets fully initialized
   */
  this.cronSyncSupport = new CronSyncSupport({
    universe: this,
    db,
    accountManager
  });

  this.extensionManager = new ExtensionManager({
    derivedViewManager,
    tocManager
  });

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

  /**
   * Track the mode of the universe. Values are:
   * - 'cron': started up in background to do tasks like sync.
   * - 'interactive': at some point during its life, it was used to provide
   *   functionality to a user interface. Once it goes 'interactive', it cannot
   *   switch back to 'cron'.
   *
   * Note that this was introduced pre-convoy as a means of keeping deferred ops
   * from interfering with cronsync.  It is not currently used in convoy because
   * the resource management system and our errbackoff-derivatives hope to
   * address elegantly what the deferred ops timeout tried to accomplish
   * bluntly.  We're not removing this yet because it does seem reasonable that
   * we care about this again in the future and it would be silly to remove it
   * just to add it back.
   */
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
  _initLogging(config) {
    // Delimit different runs of the universe from each other in the cheapest
    // way possible.
    console.log('======================');
    // XXX proper logging configuration again once things start working
    // XXX XXX XXX XXX XXX XXX XXX
    logic.realtimeLogEverything = true;
    logic.bc = new BroadcastChannel('logic');

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
        logic.realtimeLogEverything = true;
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
  _generateMigrationTasks({ accountDefs }) {
    return accountDefs.map((accountDef) => {
      return {
        type: 'account_migrate',
        accountDef
      };
    });
  },

  init() {
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
  _initFromConfig({ config, accountDefs, tasksToPlan }) {
    this._initialized = true;
    this.config = config;
    this._initLogging(config);
    logic(this, 'START_OF_LOG');
    logic(this, 'configLoaded', { config });

    this._bindStandardBroadcasts();

    // register app extensions first
    this.extensionManager.registerExtensions(this._appExtensions, 'app');
    // user-defined/installed extensions would get registered here.

    // For reasons of sanity, we bring up the account manager (which is
    // responsible for registering tasks with the task registry as needed) in
    // its entirety before we initialize the TaskManager so it can assume all
    // task-type definitions are already loaded.
    let initPromise = this.accountManager.initFromDB(accountDefs)
      .then(() => {
        return this.taskManager.__restoreFromDB();
      })
      .then(() => {
        if (tasksToPlan) {
          this.taskManager.scheduleTasks(tasksToPlan, 'initFromConfig');
        }
        this.cronSyncSupport.systemReady();
        return this;
      });

    // Now that we've told the account manager the accountDefs we can kick off
    // an ensureSync.
    this.cronSyncSupport.ensureSync('universe-init');

    // The official init process does want to wait on the task subsystems coming
    // up, however.
    return initPromise;
  },

  setInteractive() {
    this._mode = 'interactive';
  },

  //////////////////////////////////////////////////////////////////////////////
  _onConnectionChange(isOnline) {
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

    if (this.online) {
      this.taskResources.resourceAvailable('online');
    } else {
      this.taskResources.resourcesNoLongerAvailable(['online']);
    }
  },

  registerBridge(mailBridge) {
    // If you're doing anything like thinking of adding event binding here,
    // please read the comments inside broadcastOverBridges and reconsider its
    // implementation after having read this.
    this._bridges.push(mailBridge);
  },

  unregisterBridge(mailBridge) {
    var idx = this._bridges.indexOf(mailBridge);
    if (idx !== -1) {
      this._bridges.splice(idx, 1);
    }
  },

  exposeConfigForClient() {
    const config = this.config;
    return {
      debugLogging: config.debugLogging
    };
  },

  /**
   * The home for thin bindings of back-end events to be front-end events.
   *
   * Anything complicated should probably end up as its own explicit file named
   * by the event we expose to the clients.  Heck, even the simple stuff would
   * probably do well to do that, but while we're still figuring things out
   * the simple stuff can live here.  (It's possible the complex stuff really
   * belongs as tasks or other explicit named classes, so creating a directory
   * by broadcast would be inverting things from their optimal structure.)
   */
  _bindStandardBroadcasts() {
    // - config: send a sanitized version
    // While our threat model at the current time trusts the front-end, there's
    // no need to send it implementation details that it does not care about.
    this.db.on('config', () => {
      this.broadcastOverBridges(
        'config',
        this.exposeConfigForClient());
    });
  },

  /**
   * Send a named payload to all currently registered bridges to be emitted as
   * an event on the MailAPI instances.  Currently, all messages are sent
   * without concern for interest on the client side, but this could eventually
   * change should profiling show we're being ridonkulous about things.
   *
   * This is intended to be used for notable events where one of the following
   * is true:
   * - The event is nebulous and global in nature and not something directly
   *   related to something we already have data types and limited subscriptions
   *   for.
   * - The UX for notifying the user and/or helping the user deal with the
   *   problem is largely stateless and using the existing data types would
   *   be silly/inefficient or compromises the UX.
   *
   * Examples of sensible uses:
   * - Notifications of account credential problems.  There is no benefit to
   *   forcing front-end logic to add a listener to every account, but there is
   *   a lot of hassle.  Likewise, the UI for this situation is likely to be a
   *   pop-up style notification that doesn't care what else what was happening
   *   at the time.
   * - Notification of revised "new tracking" state.
   *
   * @param {String} name
   * @param {Object} data
   *   Note that this data
   */
  broadcastOverBridges(name, data) {
    // Implementation-wise, there are two ways the control flow could go:
    // 1. Iterate over the bridges and call a broadcast() method.
    // 2. MailUniverse should be an EventEmitter and it should  emit an event
    //    that the bridges are subscribed to and then they call _broadcast on
    //    themselves or _onBroadcast or something.
    //
    // We've chosen the iteration strategy somewhat arbitrarily.  The best thing
    // I can say about the choice is that the control-flow and data-flow are
    // arguably cleaner this way by having the MailBridge and MailUniverse
    // interact strictly through explicit API calls with no "soft" API surface
    // like events.
    for (let bridge of this._bridges) {
      bridge.broadcast(name, data);
    }
  },

  //////////////////////////////////////////////////////////////////////////////
  // Resource Acquisition stuff

  acquireAccountsTOC(ctx) {
    return this.accountManager.acquireAccountsTOC(ctx);
  },

  /**
   * Acquire an account.
   */
  acquireAccount(ctx, accountId) {
    return this.accountManager.acquireAccount(ctx, accountId);
  },

  /**
   * Acquire an account's folders TOC.  If you don't want the account, just its
   * folders, use this.
   *
   * Note that folderTOC's are eternal and so don't actually need reference
   * counting, etc.  However, we conform to the idiom.
   */
  acquireAccountFoldersTOC(ctx, accountId) {
    return this.accountManager.acquireAccountFoldersTOC(ctx, accountId);
  },

  /**
   * Acquire a TOC provided by the extension mechanism.  Other TOC exposures
   * could be migrated to go through this in the future, yes.
   */
  acquireExtensionTOC(ctx, namespace, name) {
    return this.tocManager.acquireExtensionTOC(ctx, namespace, name);
  },

  acquireFolderConversationsTOC(ctx, folderId) {
    let toc;
    if (this._folderConvsTOCs.has(folderId)) {
      toc = this._folderConvsTOCs.get(folderId);
    } else {
      // Figure out what the sync stamp source is for this account.  It hinges
      // on the sync granularity; if it's account-based then the sync stamps
      // will be on the account, otherwise on the folder.
      let accountId = accountIdFromFolderId(folderId);
      let engineFacts =
        this.accountManager.getAccountEngineBackEndFacts(accountId);
      let syncStampSource;
      if (engineFacts.syncGranularity === 'account') {
        syncStampSource = this.accountManager.getAccountDefById(accountId);
      } else {
        syncStampSource = this.accountManager.getFolderById(folderId);
      }
      toc = new FolderConversationsTOC({
        db: this.db,
        query: this.queryManager.queryConversations(ctx, { folderId }),
        dataOverlayManager: this.dataOverlayManager,
        metaHelpers: [
          new SyncLifecycleMetaHelper({
            folderId,
            syncStampSource,
            dataOverlayManager: this.dataOverlayManager
          }),
        ],
        onForgotten: () => {
          this._folderConvsTOCs.delete(folderId);
        }
      });
      this._folderConvsTOCs.set(folderId, toc);
    }
    return ctx.acquire(toc);
  },

  acquireSearchConversationsTOC(ctx, spec) {
    let folderId = spec.folderId;
    // Figure out what the sync stamp source is for this account.  It hinges
    // on the sync granularity; if it's account-based then the sync stamps
    // will be on the account, otherwise on the folder.
    let accountId = accountIdFromFolderId(folderId);
    let engineFacts =
      this.accountManager.getAccountEngineBackEndFacts(accountId);
    let syncStampSource;
    if (engineFacts.syncGranularity === 'account') {
      syncStampSource = this.accountManager.getAccountDefById(accountId);
    } else {
      syncStampSource = this.accountManager.getFolderById(folderId);
    }
    let toc = new FolderConversationsTOC({
      db: this.db,
      query: this.queryManager.queryConversations(ctx, spec),
      dataOverlayManager: this.dataOverlayManager,
      metaHelpers: [
        new SyncLifecycleMetaHelper({
          folderId,
          syncStampSource,
          dataOverlayManager: this.dataOverlayManager
        }),
      ],
      onForgotten: () => {
      }
    });
    return ctx.acquire(toc);
  },

  acquireFolderMessagesTOC(ctx, folderId) {
    let toc;
    if (this._folderMessagesTOCs.has(folderId)) {
      toc = this._folderMessagesTOCs.get(folderId);
    } else {
      // Figure out what the sync stamp source is for this account.  It hinges
      // on the sync granularity; if it's account-based then the sync stamps
      // will be on the account, otherwise on the folder.
      let accountId = accountIdFromFolderId(folderId);
      let engineFacts =
        this.accountManager.getAccountEngineBackEndFacts(accountId);
      let syncStampSource;
      if (engineFacts.syncGranularity === 'account') {
        syncStampSource = this.accountManager.getAccountDefById(accountId);
      } else {
        syncStampSource = this.accountManager.getFolderById(folderId);
      }
      toc = new ConversationTOC({
        db: this.db,
        query: this.queryManager.queryMessages(ctx, { folderId }),
        dataOverlayManager: this.dataOverlayManager,
        metaHelpers: [
          new SyncLifecycleMetaHelper({
            folderId,
            syncStampSource,
            dataOverlayManager: this.dataOverlayManager
          }),
        ],
        onForgotten: () => {
          this._folderMessagesTOCs.delete(folderId);
        }
      });
      this._folderMessagesTOCs.set(folderId, toc);
    }
    return ctx.acquire(toc);
  },

  acquireConversationTOC(ctx, conversationId) {
    let toc;
    if (this._conversationTOCs.has(conversationId)) {
      toc = this._conversationTOCs.get(conversationId);
    } else {
      toc = new ConversationTOC({
        db: this.db,
        query:
          this.queryManager.queryConversationMessages(ctx, { conversationId }),
        dataOverlayManager: this.dataOverlayManager,
        onForgotten: () => {
          this._conversationTOCs.delete(conversationId);
        }
      });
      this._conversationTOCs.set(conversationId, toc);
    }
    return ctx.acquire(toc);
  },

  acquireSearchConversationMessagesTOC(ctx, spec) {
    let toc = new ConversationTOC({
      db: this.db,
      query: this.queryManager.queryConversationMessages(ctx, spec),
      dataOverlayManager: this.dataOverlayManager,
      onForgotten: () => {
      }
    });
    return ctx.acquire(toc);
  },


  //////////////////////////////////////////////////////////////////////////////

  learnAboutAccount(userDetails, why) {
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
  tryToCreateAccount(userDetails, domainInfo, why) {
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
  deleteAccount(accountId, why) {
    this.taskManager.scheduleTasks([
      {
        type: 'account_delete',
        accountId
      }
    ], why);
  },

  recreateAccount(accountId, why) {
    // Latch the accountDef now since it's going away.  It's safe to do this
    // synchronously since the accountDefs are loaded by startup and the
    // AccountManager provides immediate access to them.
    let accountDef = this.accountManager.getAccountDefById(accountId);

    // Because of how the migration logic works (verbatim reuse of the account
    // id), make sure we don't schedule the migration task until the deletion
    // task has been executed.
    this.taskManager.scheduleTaskAndWaitForExecutedResult({
      type: 'account_delete',
      accountId
    }, why).then(() => {
      this.taskManager.scheduleTasks([
        {
          type: 'account_migrate',
          accountDef
        }
      ], why);
    });
  },

  /**
   * TODO: This and tryToCreateAccount should be refactored to properly be
   * tasks.
   */
  saveAccountDef(accountDef, protoConn) {
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

    // XXX shutting up the linter
    return null;
  },

  modifyConfig(accountId, mods, why) {
    return this.taskManager.scheduleTaskAndWaitForPlannedResult(
      {
        type: 'config_modify',
        mods
      },
      why);
  },


  modifyAccount(accountId, mods, why) {
    return this.taskManager.scheduleTaskAndWaitForPlannedResult(
      {
        type: 'account_modify',
        accountId,
        mods
      },
      why);
  },

  modifyIdentity(identityId, mods, why) {
    const accountId = accountIdFromIdentityId(identityId);
    return this.taskManager.scheduleTaskAndWaitForPlannedResult(
      {
        type: 'identity_modify',
        accountId,
        mods
      },
      why);
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
  shutdown(callback) {
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

  syncFolderList(accountId, why) {
    return this.taskManager.scheduleTasks([
      {
        type: 'sync_folder_list',
        accountId
      }
    ], why);
  },

  /**
   * Schedule a sync for the given folder, returning a promise that will be
   * resolved when the task group associated with the request completes.
   */
  syncGrowFolder(folderId, why) {
    console.log('in syncGrowFolder', folderId);
    const accountId = accountIdFromFolderId(folderId);
    return this.taskManager.scheduleTaskAndWaitForPlannedResult(
      {
        type: 'sync_grow',
        accountId,
        folderId
      }, why);
  },

  /**
   * Schedule a sync for the given folder, returning a promise that will be
   * resolved when the task group associated with the request completes.
   */
  syncRefreshFolder(folderId, why) {
    const accountId = accountIdFromFolderId(folderId);
    return this.taskManager.scheduleTaskAndWaitForPlannedResult(
      {
        type: 'sync_refresh',
        accountId: accountId,
        folderId: folderId
      },
      why);
  },

  fetchConversationSnippets(convIds, why) {
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

  fetchMessageBody(messageId, messageDate, why) {
    return this.taskManager.scheduleTasks([
      {
        type: 'sync_body',
        accountId: accountIdFromMessageId(messageId),
        convId: convIdFromMessageId(messageId),
        fullBodyMessageIds: new Set([messageId])
      }
    ], why);
  },

  storeLabels(conversationId, messageIds, messageSelector, addLabels,
              removeLabels) {
    return this.taskManager.scheduleTaskAndWaitForPlannedUndoTasks({
      type: 'store_labels',
      accountId: accountIdFromConvId(conversationId),
      convId: conversationId,
      onlyMessages: messageIds || null,
      messageSelector: messageSelector || null,
      add: addLabels,
      remove: removeLabels
    });
  },

  storeFlags(conversationId, messageIds, messageSelector, addFlags,
             removeFlags) {
    return this.taskManager.scheduleTaskAndWaitForPlannedUndoTasks({
      type: 'store_flags',
      accountId: accountIdFromConvId(conversationId),
      convId: conversationId,
      onlyMessages: messageIds || null,
      messageSelector: messageSelector || null,
      add: addFlags,
      remove: removeFlags
    });
  },

  /**
   * Schedule tasks previously returned as undoTasks for planning in order to
   * undo the effects of previosly planned tasks.
   *
   * SECURITY NOTE: This is currently the one code path where we directly allow
   * the front-end logic to directly tell us raw tasks to plan.  While we're not
   * designed or intended to defend against a hostile front-end, this method is
   * notable in this regard.
   */
  undo(undoTasks) {
    this.taskManager.scheduleTasks(undoTasks);
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
  createDraft({ draftType, mode, refMessageId, refMessageDate,
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

  attachBlobToDraft(messageId, attachmentDef, why) {
    // non-persistent because this is a local-only op and we don't want the
    // original stored in our database (at this time)
    return this.taskManager.scheduleNonPersistentTasks([{
      type: 'draft_attach',
      accountId: accountIdFromMessageId(messageId),
      messageId,
      attachmentDef
    }], why);
  },

  detachAttachmentFromDraft(messageId, attachmentRelId, why) {
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
  saveDraft(messageId, draftFields, why) {
    return this.taskManager.scheduleTasks([{
      type: 'draft_save',
      accountId: accountIdFromMessageId(messageId),
      messageId,
      draftFields
    }], why);
  },

  /**
   * Delete an existing (local) draft.  This eventually may end up just using
   * the normal message deletion logic under the hood, but right now this has
   * its own custom API call and task.
   */
  deleteDraft(messageId, why) {
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
  outboxSendDraft(messageId, why) {
    return this.taskManager.scheduleTaskAndWaitForPlannedResult({
      type: 'outbox_send',
      command: 'send',
      accountId: accountIdFromMessageId(messageId),
      messageId
    }, why);
  },

  /**
   * Abort the sending of a message draft (if reliably possible), moving it back
   * to be a draft.
   */
  outboxAbortSend(messageId) {
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
  outboxSetPaused(accountId, bePaused) {
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
   * @param {Object} arg
   * @param {MessageId} messageId
   * @param {DateMS} messageDate
   * @param {Map<AttachmentRelId, AttachmentSaveTarget>} parts
   */
  downloadMessageAttachments({
    messageId, messageDate, parts }) {
    return this.taskManager.scheduleTaskAndWaitForPlannedResult({
      type: 'download',
      accountId: accountIdFromMessageId(messageId),
      messageId,
      messageDate,
      parts
    });
  },

  clearNewTrackingForAccount({ accountId, silent }) {
    this.taskManager.scheduleTasks([{
      type: 'new_tracking',
      accountId,
      op: 'clear',
      silent
    }]);
  },

  /**
   * Cause a new_flush task to be scheduled so that the broadcast message gets
   * re-sent.  Assuming persistent notifications are generated, this should
   * not be needed outside of simplifying debugging logic.  If you really need
   * to be able to access this data on command, something needs to be rethought.
   */
  flushNewAggregates() {
    this.taskManager.scheduleTasks([{
      type: 'new_flush'
    }]);
  },

  /**
   * Dispatch a notification to the frontend, indicating that we're
   * done trying to send messages from the outbox for now.
   */
  notifyOutboxSyncDone(account) {
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
  createFolder(/*accountId, parentFolderId, folderName, folderType,
                 containOtherFolders*/) {
    // XXX implement!
    return;
  },

  //////////////////////////////////////////////////////////////////////////////
};


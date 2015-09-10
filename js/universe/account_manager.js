define(function(require) {
'use strict';

const logic = require('logic');

const { accountModules, engineTaskMappings } = require('../engine_glue');

const AccountsTOC = require('./db/accounts_toc');
const FoldersTOC = require('./db/folders_toc');


/**
 * Helper function that takes a function(id) {} and causes it to return any
 * existing promise with that id in this[mapPropName].  If there was no promise,
 * we invoke the function.
 *
 * This is an attempt to reduce boilerplate while also allowing for very
 * explicit function names indicating what's being loaded, etc.
 */
function prereqify(mapPropName, func) {
  return function(id) {
    let map = this[mapPropName];
    let promise = map.get(id);
    if (promise)  {
      return promise;
    }

    try {
      promise = func.apply(this, arguments);
    } catch (ex) {
      return Promise.reject(ex);
    }
    map.set(id, promise);
    return promise;
  };
}

/**
 * Manages account instance life-cycles, and the TOC of accounts and the
 * per-account folder TOC's.
 *
 *
 */
function AccountManager({ db, taskRegistry }) {
  logic.defineScope(this, 'AccountManager');

  this.db = db;
  this.taskRegistry = taskRegistry;

  this.accountsTOC = new AccountsTOC();

  this._taskTypeLoads = new Map();
  this._accountFolderTOCLoads = new Map();

  this._accountLoads = new Map();

  /** @type{Map<AccountId, FoldersTOC>} */
  this.accountFoldersTOCs = new Map();

  this.db.on('accounts!tocChange', this._onAccountRemoved.bind(this));
}
AccountManager.prototype = {
  /**
   * Initialize ourselves, returning a Promise when we're "sufficiently"
   * initialized.  This means:
   *
   * - The accountsTOC is populated and the accountDefs are known.  This happens
   *   during this call since the MailUniverse gives us this information since
   *   it loaded the account definitions when it loaded its config.
   * - Each account's tasks are loaded and registered with the TaskRegistry.
   *   This is a pre-req to initializing the TaskManager.
   * - Each account's list of folders are loaded and a FolderTOC instantiated
   *   and available for synchronous access.  (In the past, the folders were
   *   stored in a single aggregate object per account and were loaded by the
   *   universe, but we aspire to normalize and decentralize.)
   */
  initFromDB: function(accountDefs) {
    let waitFor = [];

    for (let accountDef of accountDefs) {
      waitFor.push(this._ensureTasksLoaded(accountDef.engine));
      waitFor.push(this._ensureAccountFolderTOC(accountDef.id));
    }
    return Promise.all(waitFor);
  },

  /**
   * Ensure the tasks for the given sync engine have been loaded.  In the future
   * this might become the tasks being 'registered' in the case we can cause
   * some of the tasks to only be loaded when they are actually needed.
   */
  _ensureTasksLoaded: prereqify('_taskTypeLoads', function (engineId) {
    return new Promise((resolve) => {
      require([engineTaskMappings.get(engineId)], (tasks) => {
        this.taskRegistry.registerPerAccountTypeTasks(engineId, tasks);
        resolve(true);
      });
    });
  }),

  _ensureAccountFolderTOC: prereqify('_accountFolderTOCLoads',
                                     function(accountId) {
    return new Promise((resolve) => {

    });
  }),

  /**
   * Ensure the given account has been loaded.
   */
  _ensureAccount: function (accountId, receiveProtoConn) {
    return new Promise((resolve) => {

    });

    let accountDef;
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

  acquireAccount: function(ctx, accountId) {
    return this._ensureAccount(accountId).then((account) => {
      return ctx.acquire(account);
    });
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

  acquireAccountFoldersTOC: function(ctx, accountId) {
    let foldersTOC = this.accountFoldersTOCs.get(accountId);
    if (!foldersTOC) {
      throw new Error('Account ' + accountId + ' lacks a foldersTOC!');
    }
    return Promise.resolve(foldersTOC);
  },


  /**
   * When we find out about the existence of an account, ensure that the task
   * definitions are loaded for the account and that we initiate loads of the
   * folders for the account.
   *
   * Call this to tell the AccountsTOC about the existence of an account and
   * create/remember the corresponding FoldersTOC.  This does not load the
   * account.
   *
   * Returns the wireRep for the added account for the horrible benefit of
   * saveAccountDef and the legacy MailAPI tryToCreateAccount signature.
   */
  _onAccountAdded: function(accountDef, folderInfo) {
    logic(this, 'accountExists', { accountId: accountDef.id });

    this._ensureTasksLoaded(accountDef.engine);

    // TODO: as noted above, these should really be doing lazy requires and
    // registration as accounts demand to be loaded.  (Note: not particularly
    // hard, but during current dev phase, we want to fail early, not lazily.)

    this.taskRegistry.registerPerAccountTypeTasks(
      'vanillaImap', vanillaImapTasks);
    this.taskRegistry.registerPerAccountTypeTasks(
      'activesync', activesyncTasks);
    this.taskRegistry.registerPerAccountTypeTasks(
      'pop3', pop3Tasks);


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

};
return AccountManager;
});

define(function(require) {
'use strict';

let evt = require('evt');

var IndexedDB;
if (("indexedDB" in window) && window.indexedDB) {
  IndexedDB = window.indexedDB;
} else if (("mozIndexedDB" in window) && window.mozIndexedDB) {
  IndexedDB = window.mozIndexedDB;
} else if (("webkitIndexedDB" in window) && window.webkitIndexedDB) {
  IndexedDB = window.webkitIndexedDB;
} else {
  console.error("No IndexedDB!");
  throw new Error("I need IndexedDB; load me in a content page universe!");
}

/**
 * The current database version.
 *
 * For convoy this gets bumped willy-nilly as I make minor changes to things.
 * We probably want to drop this way back down before merging anywhere official.
 */
var CUR_VERSION = 22;

/**
 * What is the lowest database version that we are capable of performing a
 * friendly-but-lazy upgrade where we nuke the database but re-create the user's
 * accounts?  Set this to the CUR_VERSION if we can't.
 *
 * Note that this type of upgrade can still be EXTREMELY DANGEROUS because it
 * may blow away user actions that haven't hit a server yet.
 */
var FRIENDLY_LAZY_DB_UPGRADE_VERSION = 5;

/**
 * The configuration table contains configuration data that should persist
 * despite implementation changes. Global configuration data, and account login
 * info.  Things that would be annoying for us to have to re-type.
 */
var TBL_CONFIG = 'config',
      CONFIG_KEY_ROOT = 'config',
      // key: accountDef:`AccountId`
      CONFIG_KEYPREFIX_ACCOUNT_DEF = 'accountDef:';

/**
 * Raw tasks that have yet to be planned.  Each raw task is its own value, and
 * each is simply named by an autoincrementing value.  Currently we entirely
 * depend on the database to issue the id's for tasks, but in the future we
 * might do this internally since it's handy to be able to synchronously assign
 * an id to a task at the time scheduleTask is called.  (OTOH, there is an
 * upside to not assigning an id until it's durably persisted.)
 */
var TBL_RAW_TASKS = 'rawTasks';

/**
 * The folder-info table stores meta-data about the known folders for each
 * account.  Per-folder sync-info is stored in the 'folderSync' table.
 *
 * key: `AccountId`
 */
var TBL_FOLDER_INFO = 'folderInfo';

/**
 * Stores the per-folder sync information.
 *
 * key: `FolderId` (these have the account id baked in)
 */
var TBL_FOLDER_SYNC = 'folderSync';

/**
 * Conversation summaries.
 *
 * key: [`AccountId`, `ConversationId`]
 */
var TBL_CONV_INFO = 'convInfo';

/**
 * The ordered list of conversations in a folder used by the Folder TOC's to
 * load the folder ordering somewhat efficiently.  Ideally this would be an
 * index but until https://www.w3.org/Bugs/Public/show_bug.cgi?id=10000 or
 * something similar lets us not have to use key-paths, the specific ordering
 * required and the many potential entries mean we'd be needlessly bloating our
 * record value with a useless representation.
 *
 * This is automatically updated by changes to TBL_CONV_INFO, specifically, for
 * each of the `labels` on the conversation (each a `FolderId`), we keep a
 * single row in existence here, using the `mostRecentMessageDate` of the
 * convInfo structure as the `DateTS`.
 *
 * key: [`FolderId`, `DateTS`, `ConversationId`]
 *
 * Note that we might eventually want
 */
var TBL_CONV_IDS_BY_FOLDER = 'convIdsByFolder'

/**
 * Message headers.
 *
 * key: [`AccountId`, `ConversationId`, `MessageId`]
 */
var TBL_HEADERS = 'headers';

/**
 * Message bodies
 *
 * key: [`AccountId`, `ConversationId`, `MessageId`]
 */
var TBL_BODIES = 'bodies';


/**
 * The set of all object stores our tasks can mutate.  Which is all of them.
 * It's not worth it for us to actually figure the subset of these that's the
 * truth.
 */
let TASK_MUTATION_STORES = [
  TBL_CONFIG,
  TBL_RAW_TASKS, TBL_FOLDER_SYNC, TBL_CONV_INFO, TBL_CONV_IDS_BY_FOLDER,
  TBL_HEADERS, TBL_BODIES
];

/**
 * Try and create a useful/sane error message from an IDB error and log it or
 * do something else useful with it.
 */
function analyzeAndLogErrorEvent(event) {
  function explainSource(source) {
    if (!source)
      return 'unknown source';
    if (source instanceof IDBObjectStore)
      return 'object store "' + source.name + '"';
    if (source instanceof IDBIndex)
      return 'index "' + source.name + '" on object store "' +
        source.objectStore.name + '"';
    if (source instanceof IDBCursor)
      return 'cursor on ' + explainSource(source.source);
    return 'unexpected source';
  }
  var explainedSource, target = event.target;
  if (target instanceof IDBTransaction) {
    explainedSource = 'transaction (' + target.mode + ')';
  }
  else if (target instanceof IDBRequest) {
    explainedSource = 'request as part of ' +
      (target.transaction ? target.transaction.mode : 'NO') +
      ' transaction on ' + explainSource(target.source);
  }
  else { // dunno, ask it to stringify itself.
    explainedSource = target.toString();
  }
  var str = 'indexedDB error:' + target.error.name + 'from' + explainedSource;
  console.error(str);
  return str;
};

function analyzeAndRejectErrorEvent(rejectFunc, event) {
  rejectFunc(analyzeAndRejectErrorEvent(event));
}

function computeSetDelta(before, after) {
  let added = new Set([x for (x of after) if (!before.has(x))]);
  let removed = new Set([x for (x of before) if (!after.has(x))]);

  return { added: added, removed: removed };
}

function wrapReq(idbRequest) {
  return new Promise(function(resolve, reject) {
    idbRequest.onsuccess = function(event) {
      resolve(event.target.result);
    };
    idbRequest.onerror = function(event) {
      reject(analyzeAndRejectErrorEvent));
    };
  });
}

/**
 * v3 prototype database.  Intended for use on the worker directly.  For
 * key-encoding efficiency and ease of account-deletion (and for privacy, etc.),
 * we may eventually want to use one account for config and then separate
 * databases for each account.
 *
 * See maildb.md for more info/context.
 *
 * @args[
 *   @param[testOptions #:optional @dict[
 *     @key[dbVersion #:optional Number]{
 *       Override the database version to treat as the database version to use.
 *       This is intended to let us do simple database migration testing by
 *       creating the database with an old version number, then re-open it
 *       with the current version and seeing a migration happen.  To test
 *       more authentic migrations when things get more complex, we will
 *       probably want to persist JSON blobs to disk of actual older versions
 *       and then pass that in to populate the database.
 *     }
 *     @key[nukeDb #:optional Boolean]{
 *       Compel ourselves to nuke the previous database state and start from
 *       scratch.  This only has an effect when IndexedDB has fired an
 *       onupgradeneeded event.
 *     }
 *   ]]
 * ]
 */
function MailDB(testOptions) {
  evt.Emitter.call(this);
  this._db = null;

  this._activeMutations = [];

  this._lazyConfigCarryover = null;

  var dbVersion = CUR_VERSION;
  if (testOptions && testOptions.dbDelta)
    dbVersion += testOptions.dbDelta;
  if (testOptions && testOptions.dbVersion)
    dbVersion = testOptions.dbVersion;
  this._dbPromise = new Promise(function(resolve, reject) {
    var openRequest = IndexedDB.open('b2g-email', dbVersion), self = this;
    openRequest.onsuccess = function(event) {
      self._db = openRequest.result;

      resolve();
    };
    openRequest.onupgradeneeded = function(event) {
      console.log('MailDB in onupgradeneeded');
      var db = openRequest.result;

      // - reset to clean slate
      if ((event.oldVersion < FRIENDLY_LAZY_DB_UPGRADE_VERSION) ||
          (testOptions && testOptions.nukeDb)) {
        self._nukeDB(db);
      }
      // - friendly, lazy upgrade
      else {
        var trans = openRequest.transaction;
        // Load the current config, save it off so getConfig can use it, then nuke
        // like usual.  This is obviously a potentially data-lossy approach to
        // things; but this is a 'lazy' / best-effort approach to make us more
        // willing to bump revs during development, not the holy grail.
        self.getConfig(function(configObj, accountInfos) {
          if (configObj)
            self._lazyConfigCarryover = {
              oldVersion: event.oldVersion,
              config: configObj,
              accountInfos: accountInfos
            };
          self._nukeDB(db);
        }, trans);
      }
    };
    openRequest.onerror = this._fatalError;
  }.bind(this));
}

MailDB.prototype = evt.mix({
  /**
   * Reset the contents of the database.
   */
  _nukeDB: function(db) {
    var existingNames = db.objectStoreNames;
    for (var i = 0; i < existingNames.length; i++) {
      db.deleteObjectStore(existingNames[i]);
    }

    db.createObjectStore(TBL_CONFIG);
    db.createObjectStore(TBL_RAW_TASKS, { autoIncrement: true })
    db.createObjectStore(TBL_FOLDER_INFO);
    db.createObjectStore(TBL_FOLDER_SYNC);
    db.createObjectStore(TBL_CONV_INFO);
    db.createObjectStore(TBL_CONV_IDS_BY_FOLDER);
    db.createObjectStore(TBL_HEADERS);
    db.createObjectStore(TBL_BODIES);
  },

  close: function() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  },

  getConfig: function(callback, trans) {
    this._dbPromise.then(function() {
      this._getConfig(callback, trans);
    }.bind(this));
  },

  _getConfig: function(callback, trans) {
    var transaction = trans ||
                      this._db.transaction([TBL_CONFIG, TBL_FOLDER_INFO],
                                           'readonly');
    var configStore = transaction.objectStore(TBL_CONFIG),
        folderInfoStore = transaction.objectStore(TBL_FOLDER_INFO);

    // these will fire sequentially
    var configReq = configStore.mozGetAll(),
        folderInfoReq = folderInfoStore.mozGetAll();

    configReq.onerror = this._fatalError;
    // no need to track success, we can read it off folderInfoReq
    folderInfoReq.onerror = this._fatalError;
    var self = this;
    folderInfoReq.onsuccess = function(event) {
      var configObj = null, accounts = [], i, obj;

      // - Check for lazy carryover.
      // IndexedDB provides us with a strong ordering guarantee that this is
      // happening after any upgrade check.  Doing it outside this closure would
      // be race-prone/reliably fail.
      if (self._lazyConfigCarryover) {
        var lazyCarryover = self._lazyConfigCarryover;
        self._lazyConfigCarryover = null;
        callback(configObj, accounts, lazyCarryover);
        return;
      }

      // - Process the results
      for (i = 0; i < configReq.result.length; i++) {
        obj = configReq.result[i];
        if (obj.id === 'config')
          configObj = obj;
        else
          accounts.push({def: obj, folderInfo: null});
      }
      for (i = 0; i < folderInfoReq.result.length; i++) {
        accounts[i].folderInfo = folderInfoReq.result[i];
      }

      try {
        callback(configObj, accounts);
      }
      catch(ex) {
        console.error('Problem in configCallback', ex, '\n', ex.stack);
      }
    };
  },

  saveConfig: function(config) {
    var req = this._db.transaction(TBL_CONFIG, 'readwrite')
                        .objectStore(TBL_CONFIG)
                        .put(config, 'config');
    req.onerror = this._fatalError;
  },

  /**
   * Save the addition of a new account or when changing account settings.  Only
   * pass `folderInfo` for the new account case; omit it for changing settings
   * so it doesn't get updated.  For coherency reasons it should only be updated
   * using saveAccountFolderStates.
   */
  saveAccountDef: function(config, accountDef, folderInfo, callback) {
    var trans = this._db.transaction([TBL_CONFIG, TBL_FOLDER_INFO],
                                     'readwrite');

    var configStore = trans.objectStore(TBL_CONFIG);
    configStore.put(config, 'config');
    configStore.put(accountDef, CONFIG_KEYPREFIX_ACCOUNT_DEF + accountDef.id);
    if (folderInfo) {
      trans.objectStore(TBL_FOLDER_INFO)
           .put(folderInfo, accountDef.id);
    }
    trans.onerror = this._fatalError;
    if (callback) {
      trans.oncomplete = function() {
        callback();
      };
    }
  },

  loadFolderSyncData: function(folderId) {
    return new Promise(function(resolve, reject) {
      var req = this._db.transaction(TBL_FOLDER_SYNC, 'readonly')
                         .objectStore(TBL_FOLDER_SYNC)
                         .get(folderId);
      req.onerror = analyzeAndRejectErrorEvent.bind(null, reject);
      req.onsuccess = function() {
        resolve(req.result);
      };
    }.bind(this));
  },

  saveFolderSyncData: function(folderId, data) {
    return new Promise(function(resolve, reject) {
      var req = this._db.transaction(TBL_FOLDER_SYNC, 'readwrite')
                         .objectStore(TBL_FOLDER_SYNC)
                         .put(folderId, data);
      req.onerror = analyzeAndRejectErrorEvent.bind(null, reject);
      req.onsuccess = function() {
        resolve(req.result);
      };
    }.bind(this));

  },

  /**
   * Idiom for buffering write event notifications until the database load
   * impacted by the writes completes.  See "maildb.md" for more info, but the
   * key idea is that:
   * - The caller issues the load and are given the data they asked for, a
   *   "drainEvents" function, and the name of the event that write mutations
   *   will occur on (as a convenience to avoid typo mismatches).
   * - We started buffering the events as soon as the load was issued.  The call
   *   to drainEvents removes our listener and synchronously calls the provided
   *   callback.  This structuring ensures that no matter what kind of promise /
   *   async control-flow shenanigans are going on, events won't get lost.
   *
   * The main footgun is:
   * - The caller needs to be responsible about calling drainEvents even if they
   *   got canceled.  Otherwise it's memory-leaks-ville.  RefedResource
   *   implementations can and should simplify their logic by forcing their
   *   consumers to wait for the load to complete first.
   *
   * Returns an object containing { drainEvents, eventId } that you should feel
   * free to mutate to use as the basis for your own return value.
   */
  _bufferChangeEventsIdiom: function(eventId) {
    let bufferedEvents = [];
    let bufferFunc = (change) => {
      bufferedEvents.push(change);
    };
    let drainEvents = (changeHandler) => {
      this.removeListener(eventId, bufferFunc);
      for (let change of bufferedEvents) {
        changeHandler(change);
      }
    };

    this.on(eventId, bufferFunc);

    return {
      drainEvents: drainEvents,
      eventId: eventId
    };
  },

  /**
   * Issue read-only batch requests.
   */
  read: function() {

  },

  beginMutate: function(ctx, mutateSet) {

  },

  /**
   * Load the ordered list of all of the known conversations.  Once loaded, the
   * caller is expected to keep up with events to maintain this ordering in
   * memory.
   *
   *
   *
   * NB: Events are synchronously emitted as writes are queued up.  This means
   * that during the same event loop that you issue this call you also need to
   * wire up your event listeners and you need to buffer those events until we
   * return this data to you.  Then you need to process that backlog of events
   * until you catch up.
   */
  loadFolderConversationIdsAndListen: function(folderId) {
    return new Promise((resolve, reject) => {
      let eventId = 'fldr!' + folderId + '!convs!tocChange';
      let retval = this._bufferChangeEventsIdiom(eventId);

      let trans = this._db.transaction(TBL_CONV_IDS_BY_FOLDER, 'readonly');
      let convIdsStore = trans.objectStore(TBL_CONV_IDS_BY_FOLDER);
      // [folderId] lower-bounds all [FolderId, DateTS, ...] keys because a
      // shorter array is by definition less than a longer array that is equal
      // up to their shared length.
      // [folderId, []] upper-bounds all [FolderId, DateTS, ...] because arrays
      // are always greater than strings/dates/numbers.  So we use this idiom
      // to simplify our lives for sanity purposes.
      let folderRange = IDBKeyRange.bound([folderId], [folderId, []],
                                          true, true);
      let tuples = yield wrapReq(convIdsStore.mozGetAll(folderRange));

      retval.idsWithDates = idsWithDates;
      return retval;
    });
  },

  /**
   * Process changes to the
   */
  _processConvMutations: function(preStates, convs, trans) {
    let convStore = trans.objectStore(TBL_CONV_INFO);
    let convIdsStore = trans.objectStore(TBL_CONV_IDS_BY_FOLDER)
    for (let convInfo of convs) {
      let preInfo = preStates[convInfo.id];
      this.emit('conv!' + convInfo.id + '!change', convInfo);
      this.emit('fldr!' + folderId + '!convs!tocChange',
                { id: convInfo.id,
                  removeDate: preInfo.date,
                  addDate: null })

      // If the most recent message date changed, we need to blow away all
      // the existing mappings and all the mappings are new anyways.
      if (preInfo.date !== convInfo.date) {
        for (let folderId of preInfo.folderIds) {
          convIdsStore.delete([folderId, preInfo.date, convInfo.id]);
        }
        for (let folderId of convInfo.folderIds) {
          let key = [folderId, convInfo.date, convInfo.id];
          // the key is also the value because we need to use mozGetAll
          convIdsStore.add(key, key);
        }
      }
      // Otherwise we need to cleverly compute the delta
      else {
        let { added, removed } = computeSetDelta(preInfo.folderIds,
                                                 convInfo.folderIds);
        for (let folderId of removed) {
          convIdsStore.delete([folderId, convInfo.date, convInfo.id]);
        }
        for (let folderId of added) {
          let key = [folderId, convInfo.date, convInfo.id];
          // the key is also the value because we need to use mozGetAll
          convIdsStore.add(key, key);
        }
      }
    }

  }

  finishMutate: function(ctx, data) {
    let trans = this._db.transaction(TASK_MUTATION_STORES, 'readwrite');

    let mutations = data.mutations;
    if (mutations) {
      if (mutations.conv) {
        this._processConvMutations(
          ctx._preMutateStates.conv, mutations.conv, trans);
      }
    }

    let newData = data.newData;
    if (newData) {
      if (newData.conv) {
        let convStore = trans.objectStore(TBL_CONV_INFO);
        for (let convInfo of conv) {

        }
      }
      if (newData.msg) {

      }
      if (newData.body) {

      }
    }


  },

  /**
   * Coherently update the state of the folderInfo for an account plus all dirty
   * blocks at once in a single (IndexedDB and SQLite) commit. If we broke
   * folderInfo out into separate keys, we could do this on a per-folder basis
   * instead of per-account.  Revisit if performance data shows stupidity.
   *
   * @args[
   *   @param[accountId]
   *   @param[folderInfo]
   *   @param[perFolderStuff @listof[@dict[
   *     @key[id FolderId]
   *     @key[headerBlocks @dictof[@key[BlockId] @value[HeaderBlock]]]
   *     @key[bodyBlocks @dictof[@key[BlockID] @value[BodyBlock]]]
   *   ]]]
   * ]
   */
  saveAccountFolderStates: function(accountId, folderInfo, perFolderStuff,
                                    deletedFolderIds, callback) {
    var trans = this._db.transaction([TBL_FOLDER_INFO, TBL_HEADER_BLOCKS,
                                      TBL_BODY_BLOCKS], 'readwrite');
    trans.onerror = this._fatalError;
    trans.objectStore(TBL_FOLDER_INFO).put(folderInfo, accountId);

    var headerStore = trans.objectStore(TBL_HEADER_BLOCKS),
        bodyStore = trans.objectStore(TBL_BODY_BLOCKS),
        i;

    /**
     * Calling put/delete on operations can be fairly expensive for these blocks
     * (4-10ms+) which can cause major jerk while scrolling to we send block
     * operations individually (but inside of a single block) to improve
     * responsiveness at the cost of throughput.
     */
    var operationQueue = [];

    function addToQueue() {
      var args = Array.slice(arguments);
      var store = args.shift();
      var type = args.shift();

      operationQueue.push({
        store: store,
        type: type,
        args: args
      });
    }

    function workQueue() {
      var pendingRequest = operationQueue.shift();

      // no more the transition complete handles the callback
      if (!pendingRequest)
        return;

      var store = pendingRequest.store;
      var type = pendingRequest.type;

      var request = store[type].apply(store, pendingRequest.args);

      request.onsuccess = request.onerror = workQueue;
    }

    for (i = 0; i < perFolderStuff.length; i++) {
      var pfs = perFolderStuff[i], block;

      for (var headerBlockId in pfs.headerBlocks) {
        block = pfs.headerBlocks[headerBlockId];
        if (block)
          addToQueue(headerStore, 'put', block, pfs.id + ':' + headerBlockId);
        else
          addToQueue(headerStore, 'delete', pfs.id + ':' + headerBlockId);
      }

      for (var bodyBlockId in pfs.bodyBlocks) {
        block = pfs.bodyBlocks[bodyBlockId];
        if (block)
          addToQueue(bodyStore, 'put', block, pfs.id + ':' + bodyBlockId);
        else
          addToQueue(bodyStore, 'delete', pfs.id + ':' + bodyBlockId);
      }
    }

    if (deletedFolderIds) {
      for (i = 0; i < deletedFolderIds.length; i++) {
        var folderId = deletedFolderIds[i],
            range = IDBKeyRange.bound(folderId + ':',
                                      folderId + ':\ufff0',
                                      false, false);
        addToQueue(headerStore, 'delete', range);
        addToQueue(bodyStore, 'delete', range);
      }
    }

    if (callback) {
      trans.addEventListener('complete', function() {
        callback();
      });
    }

    workQueue();

    return trans;
  },

  /**
   * Delete all traces of an account from the database.
   */
  deleteAccount: function(accountId) {
    var trans = this._db.transaction([TBL_CONFIG, TBL_FOLDER_INFO,
                                      TBL_HEADER_BLOCKS, TBL_BODY_BLOCKS],
                                      'readwrite');
    trans.onerror = this._fatalError;

    trans.objectStore(TBL_CONFIG).delete('accountDef:' + accountId);
    trans.objectStore(TBL_FOLDER_INFO).delete(accountId);
    var range = IDBKeyRange.bound(accountId + '.',
                                  accountId + '.\ufff0',
                                  false, false);
    trans.objectStore(TBL_HEADER_BLOCKS).delete(range);
    trans.objectStore(TBL_BODY_BLOCKS).delete(range);
  },
});

// XXX REFACTOR just start returning this directly
return {
  MailDB: MailDB
};
});

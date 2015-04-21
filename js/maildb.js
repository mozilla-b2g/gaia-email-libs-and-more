define(function(require) {
'use strict';

const co = require('co');
const evt = require('evt');
const logic = require('./logic');

const {
  indexedDB, IDBObjectStore, IDBIndex, IDBCursor, IDBTransaction, IDBRequest,
  IDBKeyRange
} = window;


/**
 * The current database version.
 *
 * For convoy this gets bumped willy-nilly as I make minor changes to things.
 * We probably want to drop this way back down before merging anywhere official.
 */
const CUR_VERSION = 34;

/**
 * What is the lowest database version that we are capable of performing a
 * friendly-but-lazy upgrade where we nuke the database but re-create the user's
 * accounts?  Set this to the CUR_VERSION if we can't.
 *
 * Note that this type of upgrade can still be EXTREMELY DANGEROUS because it
 * may blow away user actions that haven't hit a server yet.
 */
const FRIENDLY_LAZY_DB_UPGRADE_VERSION = 23;

/**
 * The configuration table contains configuration data that should persist
 * despite implementation changes. Global configuration data, and account login
 * info.  Things that would be annoying for us to have to re-type.
 *
 * Managed by: MailUniverse
 */
const TBL_CONFIG = 'config',
      // key: accountDef:`AccountId`
      CONFIG_KEYPREFIX_ACCOUNT_DEF = 'accountDef:';

/**
 * Synchronization states.  What this means is account-dependent.
 *
 * For Gmail IMAP, this currently means a single record keyed by the accountId.
 *
 * For other IMAP (in the future), this will likely be a per-folder record
 * keyed by the FolderId.
 *
 * For POP3 (in the future), this will likely be the existing single giant
 * sync state blob we use.  (Which is mainly overflow UIDLs and deleted UIDLs.)
 *
 * ActiveSync isn't totally clear; it depends a lot on how much server support
 * we reliably get for conversations giving our targeted legacy support goal.
 * But most likely is per-folder record keeyed by FolderId.
 */
const TBL_SYNC_STATES = 'syncStates';

/**
 * (Wrapped) tasks.  We issue id's for now, although in an ideal world we could
 * use auto-incremented id's.  But we can't since all we have is mozGetAll.  See
 * commentary elsewhere.
 */
const TBL_TASKS = 'tasks';

/**
 * The folder-info table stores meta-data about the known folders for each
 * account in a single big value.
 *
 * key: `AccountId`
 *
 * value: { meta: Object, folders: Map }
 *
 * Managed by: MailUniverse/MailAccount
 */
const TBL_FOLDER_INFO = 'folderInfo';

/**
 * Conversation summaries.
 *
 * key: `ConversationId` (these also have the account id baked in)
 *
 * Managed by: MailDB
 */
const TBL_CONV_INFO = 'convInfo';

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
 * Managed by: MailDB
 */
const TBL_CONV_IDS_BY_FOLDER = 'convIdsByFolder'

/**
 * Message headers.
 *
 * key: [`AccountId`, `ConversationId`, `MessageId`]
 *
 * Managed by: MailDB
 */
const TBL_HEADERS = 'headers';

/**
 * Message bodies
 *
 * key: [`AccountId`, `ConversationId`, `MessageId`]
 *
 * Managed by: MailDB
 */
const TBL_BODIES = 'bodies';


/**
 * The set of all object stores our tasks can mutate.  Which is all of them.
 * It's not worth it for us to actually figure the subset of these that's the
 * truth.
 */
const TASK_MUTATION_STORES = [
  TBL_CONFIG,
  TBL_SYNC_STATES,
  TBL_TASKS,
  TBL_FOLDER_INFO,
  TBL_CONV_INFO, TBL_CONV_IDS_BY_FOLDER,
  TBL_HEADERS, TBL_BODIES
];

/**
 * Try and create a useful/sane error message from an IDB error and log it or
 * do something else useful with it.
 */
function analyzeAndLogErrorEvent(event) {
  function explainSource(source) {
    if (!source) {
      return 'unknown source';
    }
    if (source instanceof IDBObjectStore) {
      return 'object store "' + source.name + '"';
    }
    if (source instanceof IDBIndex) {
      return 'index "' + source.name + '" on object store "' +
        source.objectStore.name + '"';
    }
    if (source instanceof IDBCursor) {
      return 'cursor on ' + explainSource(source.source);
    }
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
}

function analyzeAndRejectErrorEvent(rejectFunc, event) {
  rejectFunc(analyzeAndRejectErrorEvent(event));
}

function computeSetDelta(before, after) {
  let added = new Set();
  let kept = new Set();
  let removed = new Set();

  for (let key of before) {
    if (after.has(key)) {
      kept.add(key);
    } else {
      removed.add(key);
    }
  }
  for (let key of after) {
    if (!before.has(key)) {
      added.add(key);
    }
  }

  return { added: added, kept: kept, removed: removed };
}

let eventForFolderId = folderId => 'fldr!' + folderId + '!convs!tocChange';

/**
 * Wrap a (read) request into a
 */
function wrapReq(idbRequest) {
  return new Promise(function(resolve, reject) {
    idbRequest.onsuccess = function(event) {
      resolve(event.target.result);
    };
    idbRequest.onerror = function(event) {
      reject(analyzeAndLogErrorEvent(event));
    };
  });
}

/**
 * Wrap a (presumably write) transaction
 */
function wrapTrans(idbTransaction) {
  return new Promise(function(resolve, reject) {
    idbTransaction.oncomplete = function(event) {
      resolve();
    };
    idbTransaction.onerror = function(event) {
      reject(analyzeAndLogErrorEvent(event));
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
  logic.defineScope(this, 'MailDB');

  this._db = null;

  this._lazyConfigCarryover = null;

  this.convCache = new Map();
  this.headerCache = new Map();
  this.bodyCache = new Map();

  let dbVersion = CUR_VERSION;
  if (testOptions && testOptions.dbDelta) {
    dbVersion += testOptions.dbDelta;
  }
  if (testOptions && testOptions.dbVersion) {
    dbVersion = testOptions.dbVersion;
  }
  this._dbPromise = new Promise((resolve, reject) => {
    let openRequest = indexedDB.open('b2g-email', dbVersion);
    openRequest.onsuccess = (event) => {
      this._db = openRequest.result;

      resolve();
    };
    openRequest.onupgradeneeded = (event) => {
      console.log('MailDB in onupgradeneeded');
      logic(this, 'upgradeNeeded', { oldVersion: event.oldVersion,
                                     curVersion: dbVersion });
      let db = openRequest.result;

      // - reset to clean slate
      if ((event.oldVersion < FRIENDLY_LAZY_DB_UPGRADE_VERSION) ||
          (testOptions && testOptions.nukeDb)) {
        this._nukeDB(db);
      }
      // - friendly, lazy upgrade
      else {
        var trans = openRequest.transaction;
        // Load the current config, save it off so getConfig can use it, then
        // nuke like usual.  This is obviously a potentially data-lossy approach
        // to things; but this is a 'lazy' / best-effort approach to make us
        // more willing to bump revs during development, not the holy grail.
        this._getConfig((configObj, accountInfos) => {
          if (configObj) {
            this._lazyConfigCarryover = {
              oldVersion: event.oldVersion,
              config: configObj,
              accountInfos: accountInfos
            };
          }
          this._nukeDB(db);
        }, trans);
      }
    };
    openRequest.onerror = analyzeAndRejectErrorEvent.bind(null, reject);
  });
}

MailDB.prototype = evt.mix({
  /**
   * Reset the contents of the database.
   */
  _nukeDB: function(db) {
    logic(this, 'nukeDB', {});
    let existingNames = db.objectStoreNames;
    for (let i = 0; i < existingNames.length; i++) {
      db.deleteObjectStore(existingNames[i]);
    }

    db.createObjectStore(TBL_CONFIG);
    db.createObjectStore(TBL_SYNC_STATES);
    db.createObjectStore(TBL_TASKS);
    db.createObjectStore(TBL_FOLDER_INFO);
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
    if (trans) {
      throw new Error('use _getConfig if you have a transaction');
    }
    this._dbPromise.then(() => {
      this._getConfig(callback, trans);
    });
  },

  _getConfig: function(callback, trans) {
    logic(this, '_getConfig', { trans: !!trans });
    var transaction = trans ||
                      this._db.transaction([TBL_CONFIG, TBL_FOLDER_INFO],
                                           'readonly');
    var configStore = transaction.objectStore(TBL_CONFIG),
        folderInfoStore = transaction.objectStore(TBL_FOLDER_INFO);

    // these will fire sequentially
    var configReq = configStore.mozGetAll(),
        folderInfoReq = folderInfoStore.mozGetAll();

    configReq.onerror = analyzeAndLogErrorEvent;
    // no need to track success, we can read it off folderInfoReq
    folderInfoReq.onerror = analyzeAndLogErrorEvent;
    folderInfoReq.onsuccess = (event) => {
      var configObj = null, accounts = [], i, obj;

      // - Check for lazy carryover.
      // IndexedDB provides us with a strong ordering guarantee that this is
      // happening after any upgrade check.  Doing it outside this closure would
      // be race-prone/reliably fail.
      if (this._lazyConfigCarryover) {
        var lazyCarryover = this._lazyConfigCarryover;
        this._lazyConfigCarryover = null;
        callback(configObj, accounts, lazyCarryover);
        return;
      }

      // - Process the results
      for (i = 0; i < configReq.result.length; i++) {
        obj = configReq.result[i];
        if (obj.id === 'config') {
          configObj = obj;
        } else {
          accounts.push({def: obj, folderInfo: null});
        }
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
    req.onerror = analyzeAndLogErrorEvent;
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
    trans.onerror = analyzeAndLogErrorEvent;
    if (callback) {
      trans.oncomplete = function() {
        callback();
      };
    }
  },

  /**
   * Placeholder mechanism for things to tell us it might be a good time to do
   * something cache-related.
   *
   * Current callers:
   * - 'read': A database read batch completed and so there may now be a bunch
   *   more stuff in the cache.
   *
   * @param {String} why
   *   What happened, ex: 'read'.
   * @param {Object} ctx
   *   The TaskContext/BridgeContext/whatever caused us to do this.  Because
   *   things that read data are likely to hold it as long as they need it,
   *   there probably isn't much value in tracking 'live consumers'; the benefit
   *   of the cache would primarily be in the locality benefits where the next
   *   context that cares isn't going to be the one that read it from disk.  So
   *   this would be for debugging, and maybe should just be removed.
   */
  _considerCachePressure: function(why, ctx) {

  },

  emptyCache: function() {
    this.emit('cacheDrop');

    this.convCache.clear();
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
  read: function(ctx, requests) {
    return new Promise((resolve, reject) => {
      let trans = this._db.transaction(TASK_MUTATION_STORES, 'readonly');

      let dbReqCount = 0;

      if (requests.syncStates) {
        let syncStore = trans.objectStore(TBL_SYNC_STATES);
        let syncStatesRequestsMap = requests.syncStates;
        for (let key of syncStatesRequestsMap.keys()) {
          dbReqCount++;
          let req = syncStore.get(key);
          let handler = (event) => {
            let value;
            if (req.error) {
              value = null;
              analyzeAndLogErrorEvent(event);
            } else {
              value = req.result;
            }
            syncStatesRequestsMap.set(key, value);
          };
          req.onsuccess = handler;
          req.onerror = handler;
        }
      }

      if (requests.conversations) {
        let convStore = trans.objectStore(TBL_CONV_INFO);
        let convRequestsMap = requests.conversations;
        for (let convId of convRequestsMap.keys()) {
          // fill from cache if available
          if (this.convCache.has(convId)) {
            convRequestsMap.set(convId, this.convCache.get(convId));
            continue;
          }

          // otherwise we need to ask the database
          dbReqCount++;
          let req = convStore.get(convId);
          let handler = (event) => {
            let value;
            if (req.error) {
              value = null;
              analyzeAndLogErrorEvent(event);
            } else {
              value = req.result;
            }
            this.convCache.set(convId, value);
            convRequestsMap.set(convId, value);
          };
          req.onsuccess = handler;
          req.onerror = handler;
        }
      }
      if (requests.headers) {
        let headerStore = trans.objectStore(TBL_HEADERS);
        let headerRequestsMap = requests.headers;
        for (let headerId of headerRequestsMap.keys()) {
          // fill from cache if available
          if (this.headerCache.has(headerId)) {
            headerRequestsMap.set(headerId, this.headerCache.get(headerId));
            continue;
          }

          // otherwise we need to ask the database
          dbReqCount++;
          let req = headerStore.get(headerId);
          let handler = (event) => {
            let value;
            if (req.error) {
              value = null;
              analyzeAndLogErrorEvent(event);
            } else {
              value = req.result;
            }
            this.headerCache.set(headerId, value);
            headerRequestsMap.set(headerId, value);
          };
          req.onsuccess = handler;
          req.onerror = handler;
        }
      }
      if (requests.bodies) {
        let bodyStore = trans.objectStore(TBL_BODIES);
        let bodyRequestsMap = requests.bodies;
        for (let bodyId of bodyRequestsMap.keys()) {
          // fill from cache if available
          if (this.bodyCache.has(bodyId)) {
            bodyRequestsMap.set(bodyId, this.bodyCache.get(bodyId));
            continue;
          }

          // otherwise we need to ask the database
          dbReqCount++;
          let req = bodyStore.get(bodyId);
          let handler = (event) => {
            let value;
            if (req.error) {
              value = null;
              analyzeAndLogErrorEvent(event);
            } else {
              value = req.result;
            }
            this.bodyCache.set(bodyId, value);
            bodyRequestsMap.set(bodyId, value);
          };
          req.onsuccess = handler;
          req.onerror = handler;
        }
      }

      if (!dbReqCount) {
        resolve();
        // it would be nice if we could have avoided creating the transaction...
      } else {
        trans.oncomplete = () => {
          resolve();
          this._considerCachePressure('read', ctx);
        };
      }
    });
  },

  /**
   * Acquire mutation rights for the given set of records.
   *
   * Currently this just means:
   * - Do the read
   * - Save the state off from the reads to that in finishMutate we can do any
   *   delta work required.
   *
   * In the TODO future this will also mean:
   * - Track active mutations so we can detect collisions and serialize
   *   mutations.  See maildb.md for more.
   */
  beginMutate: function(ctx, mutateRequests) {
    if (ctx._preMutateStates) {
      throw new Error('Context already has mutation states tracked?!');
    }

    return this.read(ctx, mutateRequests).then(() => {
      let preMutateStates = ctx._preMutateStates = {};

      // (nothing to do for "syncStates")

      // (nothing to do for "folders")

      // Right now we only care about conversations because all other data types
      // have no complicated indices to maintain.
      if (mutateRequests.conversations) {
        let preConv = preMutateStates.conversations = new Map();
        for (let conv of mutateRequests.conversations.values()) {
          if (!conv) {
            // It's conceivable for the read to fail, and it will already have
            // logged.  So just skip any explosions here.
            continue;
          }

          preConv.set(conv.id, { date: conv.date, folderIds: conv.folderIds });
        }
      }

      // (nothing to do for "headers")

      // (nothing to do for "bodies")
    });
  },

  /**
   * Load all tasks from the database.  Ideally this is called before any calls
   * to addTasks if you want to avoid having a bad time.
   */
  loadTasks: function() {
    let trans = this._db.transaction([TBL_TASKS], 'readonly');
    let taskStore = trans.objectStore(TBL_TASKS);
    return wrapReq(taskStore.mozGetAll());
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
  loadFolderConversationIdsAndListen: co.wrap(function*(folderId) {
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

    retval.idsWithDates = tuples.map(function(x) {
      return { date: x[1], id: x[2]};
    });
    return retval;
  }),

  _processConvAdditions: function(trans, convs) {
    let convStore = trans.objectStore(TBL_CONV_INFO);
    let convIdsStore = trans.objectStore(TBL_CONV_IDS_BY_FOLDER);
    for (let convInfo of convs) {
      convStore.add(convInfo, convInfo.id);

      for (let folderId of convInfo.folderIds) {
        this.emit(eventForFolderId,
                  {
                    id: convInfo.id,
                    item: convInfo,
                    removeDate: null,
                    addDate: convInfo.date
                  });

        let key = [folderId, convInfo.date, convInfo.id];
        // the key is also the value because we need to use mozGetAll
        convIdsStore.add(key, key);
      }
    }
  },

  /**
   * Process changes to conversations.  This does not cover additions, but it
   * does cover deletion.
   */
  _processConvMutations: function(trans, preStates, convs) {
    let convStore = trans.objectStore(TBL_CONV_INFO);
    let convIdsStore = trans.objectStore(TBL_CONV_IDS_BY_FOLDER);
    for (let [convId, convInfo] of convs) {
      let preInfo = preStates[convId];

      // Deletion
      if (convInfo === null) {
        convStore.delete(convId);
      } else { // Modification
        convStore.put(convInfo, convId);
      }

      // Notify specific listeners, and yeah, deletion is just telling a null
      // value.
      this.emit('conv!' + convInfo.id + '!change', convId, convInfo);


      let { added, kept, removed } = computeSetDelta(preInfo.folderIds,
                                                     convInfo.folderIds);

      // Notify the TOCs
      for (let folderId of added) {
        this.emit(eventForFolderId(folderId),
                  {
                    id: convId,
                    item: convInfo,
                    removeDate: null,
                    addDate: convInfo.date
                  });
      }
      // (We still want to generate an event even if there is no date change
      // since otherwise the TOC won't know something has changed.)
      for (let folderId of kept) {
        this.emit(eventForFolderId(folderId),
                  {
                    id: convId,
                    item: convInfo,
                    removeDate: preInfo.date,
                    addDate: convInfo.date
                  });
      }
      for (let folderId of removed) {
        this.emit(eventForFolderId(folderId),
                  {
                    id: convId,
                    item: convInfo,
                    removeDate: preInfo.date,
                    addDate: null
                  });
      }

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

  },

  _processHeaderAdditions: function(trans, headers) {
    let store = trans.objectStore(TBL_HEADERS);
    for (let header of headers.values()) {
      store.add(header, header.id);
    }
  },

  _processHeaderMutations: function(trans, preStates, headers) {

  },

  _processBodyAdditions: function(trans, bodies) {

  },

  _processBodyMutations: function(trans, preStates, bodies) {

  },

  _addRawTasks: function(trans, wrappedTasks) {
    let store = trans.objectStore(TBL_TASKS);
    wrappedTasks.forEach((wrappedTask) => {
      store.add(wrappedTask, wrappedTask.id);
    });
  },

  /**
   * Insert the raw task portions of each provided wrappedTask into the databse,
   * storing the resulting autogenerated id into the `id` field of each
   * wrappedTask.  A promise is returned; when it is resolved, all of the
   * wrappedTasks should have had an id assigned.
   */
  addTasks: function(wrappedTasks) {
    let trans = this._db.transaction([TBL_TASKS], 'readwrite');
    this._addRawTasks(trans, wrappedTasks);
    return wrapTrans(trans);
  },

  finishMutate: function(ctx, data, taskData) {
    logic(this, 'finishMutate:begin', { ctxId: ctx.id });
    let trans = this._db.transaction(TASK_MUTATION_STORES, 'readwrite');

    let mutations = data.mutations;
    if (mutations) {
      if (mutations.syncStates) {
        for (let [key, syncState] of mutations.syncStates) {
          trans.objectStore(TBL_SYNC_STATES).put(syncState, key);
        }
      }

      if (mutations.folders) {
        for (let [accountId, foldersDbState] of mutations.folders) {
          trans.objectStore(TBL_FOLDER_INFO).put(foldersDbState, accountId);
        }
      }

      if (mutations.conversations) {
        this._processConvMutations(
          trans, ctx._preMutateStates.conversations, mutations.conversations);
      }

      if (mutations.headers) {
        this._processHeaderMutations(
          trans, ctx._preMutateStates.headers, mutations.headers);
      }

      if (mutations.bodies) {
        this._processBodyMutations(
          trans, ctx._preMutateStates.bodies, mutations.bodies);
      }
    }

    let newData = data.newData;
    if (newData) {
      if (newData.conv) {
        this._processConvAdditions(trans, newData.conv);
      }
      if (newData.headers) {
        this._processHeaderAdditions(trans, newData.headers);
      }
      if (newData.bodies) {
        this._processBodyAdditions(trans, newData.bodies);
      }
      // newData.tasks is transformed by the TaskContext into
      // taskData.wrappedTasks
    }

    // Update the task's state in the database.
    if (taskData.revisedTaskInfo) {
      let revisedTaskInfo = taskData.revisedTaskInfo;
      if (revisedTaskInfo.state) {
        trans.objectStore(TBL_TASKS).put(revisedTaskInfo.state,
                                         revisedTaskInfo.id);
      } else {
        trans.objectStore(TBL_TASKS).delete(revisedTaskInfo.id);
      }
    }

    // New tasks
    if (taskData.wrappedTasks) {
      let taskStore = trans.objectStore(TBL_TASKS);
      for (let wrappedTask of taskData.wrappedTasks) {
        taskStore.put(wrappedTask, wrappedTask.id);
      }
    }

    return wrapTrans(trans).then(() => {
      logic(this, 'finishMutate:end');
    });
  },

  /**
   * Delete all traces of an account from the database.
   */
  deleteAccount: function(accountId) {
    var trans = this._db.transaction([TBL_CONFIG, TBL_FOLDER_INFO],
                                      'readwrite');
    trans.onerror = analyzeAndLogErrorEvent;

    trans.objectStore(TBL_CONFIG).delete('accountDef:' + accountId);
    trans.objectStore(TBL_FOLDER_INFO).delete(accountId);
  },
});

return MailDB;
});

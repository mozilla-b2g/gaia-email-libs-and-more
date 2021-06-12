import evt from 'evt';
import logic from 'logic';

import { accountIdFromFolderId, convIdFromMessageId,
        messageSpecificIdFromMessageId } from 'shared/id_conversions';

const {
  indexedDB, IDBObjectStore, IDBIndex, IDBCursor, IDBTransaction, IDBRequest,
  IDBKeyRange
} = globalThis;


/**
 * The current database version.
 *
 * For convoy this gets bumped willy-nilly as I make minor changes to things.
 * We probably want to drop this way back down before merging anywhere official.
 */
const CUR_VERSION = 123;

/**
 * What is the lowest database version that we are capable of performing a
 * friendly-but-lazy upgrade where we nuke the database but re-create the user's
 * accounts?  Set this to the CUR_VERSION if we can't.
 *
 * Note that this type of upgrade can still be EXTREMELY DANGEROUS because it
 * may blow away user actions that haven't hit a server yet.
 */
const FRIENDLY_LAZY_DB_UPGRADE_VERSION = 122;

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
 * For vanilla IMAP, this is a per-folder record keyed by the FolderId.
 *
 * For POP3, this is a single record keyed by AccountId.
 *
 * For ActiveSync we have both global and per-folder storage.  The global
 * storage is keyed by accountId and the per-folder storage is keyed by
 * FolderId.
 *
 * NB: The AccountId is a prefix of the FolderId.
 */
const TBL_SYNC_STATES = 'syncStates';

/**
 * (Wrapped) tasks.  We issue id's for now, although in an ideal world we could
 * use auto-incremented id's.  But we can't since all we have is mozGetAll.  See
 * commentary elsewhere. XXX Things have changed since then for IDB.
 */
const TBL_TASKS = 'tasks';

/**
 * Complex task state to be loaded in its entirety when tasks are intialized for
 * an account.  Complex tasks can store either a single object of their choosing
 * in here, or have multiple keyed values that are automatically loaded into a
 * map.
 *
 * Since the information is kept in-memory once loaded and should be of limited
 * size, the single object form will usually be a good choice.  However, in
 * cases involving DOM Blobs/Files where we need to write values to disk and
 * then read them back to convert them from a memory-backed Blob to a
 * disk-backed File and such manipulations may want to logically occur in
 * parallel, the multi-record Map implementation may be preferable.  (Noting
 * that the IndexedB transactions will be serialized.  But our tasks operate on
 * a higher abstraction level and it's easier to reason about if we can view
 * them as distinct records with orthogonal life cycles.)
 *
 * The key is a composite of:
 * - `AccountId`: Because complex tasks are managed on a per-account basis.
 * - `ComplexTaskName`: Namespaces the task.
 * - Optional `ComplexTaskKey`: If doing the Map, this key will exist.
 *   Otherwise the key will be a 2-item Array.
 *
 * key: [`AccountId`, `ComplexTaskName`, ...key]
 *
 * This data is loaded at startup for task prioritization reasons.  Writes are
 * made as part of task completing transactions.
 */
const TBL_COMPLEX_TASKS = 'complexTasks';

/**
 * The folder-info table stores meta-data about the known folders for each
 * account in a single big value.
 *
 * key: `FolderId` (which has the AccountId baked in)
 *
 * value: FolderInfo
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
 * Originally the idea was that this would be an index where the key itself
 * included all the required information.  We've now changed this so that the
 * value also includes the "quantized height" of the conversation for display
 * purposes.
 *
 * Because the date portion of they key is already mutable and needs to be
 * known to delete the record, we could indeed store everything in the key.
 * The fact that the value exists at all is due to mozGetAll being the only
 * batch API available to us.  So what goes in the key is a question of what is
 * needed for uniqueness and ordering.  Since the height is not needed for that
 * and we have to use mozGetAll and values to actually read, the height only
 * goes in the value. XXX IDB has advanced somewhat and/or pending changes may
 * help.
 *
 * key: [`FolderId`, `DateTS`, `ConversationId`]
 * value: [`FolderId`, `DateTS`, `ConversationId`, `QuantizedHeight`]
 *
 * Managed by: MailDB
 */
const TBL_CONV_IDS_BY_FOLDER = 'convIdsByFolder';

/**
 * This is a message-centric version of TBL_CONV_IDS_BY_FOLDER.
 *
 * For now we also do the same redundant key/value approach used for
 * conversations as well.
 *
 * key: [`FolderId`, `DateTS`, `GmailMessageId`]
 * value: [`FolderId`, `DateTS`, `GmailMessageId`]
 *
 * Managed by: MailDB
 */
const TBL_MSG_IDS_BY_FOLDER = 'msgIdsByFolder';

/**
 * The messages, containing both header/envelope and body aspects.  The actual
 * body parts are stored in Blobs which means that they may only be accessed
 * asynchronously.  (Contrast: in v1, headers and bodies were stored
 * separately for reasons you don't care about.)
 *
 * key: [`ConversationId`, `DateTS`, `GmailMessageId`]
 *
 * Ranges:
 * - [convId] lower-bounds all [convId, ...] keys because a shorter array
 *   is by definition less than a longer array that is equal up to their
 *   shared length.
 * - [convId, []] upper-bounds all [convId, ...] because arrays are always
 *   greater than strings/dates/numbers.
 *
 * Managed by: MailDB
 */
const TBL_MESSAGES = 'messages';

/**
 * Maps normalized (quotes and arrows removed) message-id header values to
 * the conversation/messages they belong to.
 *
 * key: [`AccountId`, `NormalizedMessageIdHeader`]
 * value: either a `ConversationId` or an array of `MessageId`s.
 */
const TBL_HEADER_ID_MAP = 'headerIdMap';

/**
 * Indirection table from uniqueMessageId to the server location of messages.
 *
 * key: `UniqueMessageId` (which has the AccountId baked in)
 */
const TBL_UMID_LOCATION = 'umidLocationMap';

/**
 * Indirection table from uniqueMessageId to the messageId of the corresponding
 * message.
 *
 * key: `UniqueMessageId` (which has the AccountId baked in)
 */
const TBL_UMID_NAME = 'umidNameMap';

/**
 * Log records for extremely significant events.  The first component of the
 * composite key is a timestamp so that we can easily reap logs older than a
 * given time-horizon.
 *
 * While logs may be added and/or updated as part of a task, we also support an
 * API for writing these logs outside of a task for paranoia/failsafe reasons.
 *
 * key: [timestamp, type, id]
 * - timestamp: Date.now() when whatever we're logging about was started.
 * - type: The record type like 'cronsync'.  This is used in conjunction with
 *   the id by the creator of the log entry to provide uniqueness while also
 *   allowing easy fire-and-forget updates.  (AKA we could have IndexedDB
 *   allocate id's to provide uniqueness, but then we have to wait around to
 *   hear what id was issued, plus it complicates time-based reaping.)
 * - id: An id allocated by the logger that should be unique for the given
 *   timestamp and type.
 *
 * Examples of extremely significant events:
 * - cronsync attempts/results.  We've had a history of our periodic sync not
 *   being reliable.  To this end it's vital for us to know when we actually
 *   woke up to try and periodically sync, whether we had the network access
 *   we desired, what type of failures we encountered, if any, etc.  We perform
 *   initial writes as part of cronsync outside the task infrastructure because
 *   the task infrastructure may hang.
 */
const TBL_BOUNDED_LOGS = 'logs';

/**
 * How long should we keep circular logs around for?  Right now we're
 * arbitrarily going with two weeks because:
 * - The amount of data is not insane.
 * - This should cover cases of dogfooders going on vacation for a week and
 *   noticing something's not working, getting home, getting back in the groove,
 *   and then pulling the logs off.
 */
const BOUNDED_LOG_KEEP_TIME_MILLIS = 14 * 24 * 60 * 60 * 1000;

/**
 * The set of all object stores our tasks can mutate.  Which is all of them.
 * It's not worth it for us to actually figure the subset of these that's the
 * truth.
 */
const TASK_MUTATION_STORES = [
  TBL_CONFIG,
  TBL_SYNC_STATES,
  TBL_TASKS, TBL_COMPLEX_TASKS,
  TBL_FOLDER_INFO,
  TBL_CONV_INFO, TBL_CONV_IDS_BY_FOLDER,
  TBL_MESSAGES, TBL_MSG_IDS_BY_FOLDER,
  TBL_HEADER_ID_MAP, TBL_UMID_LOCATION, TBL_UMID_NAME,
  TBL_BOUNDED_LOGS
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
  var str = 'indexedDB error:' + target.error.name + ' from ' + explainedSource;
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

/**
 * Given a dictionary of deltas whose keys are fields and values are values to
 * add (which can be negative to subtract) to the provided object.  Helper for
 * atomicDeltas logic.
 */
const applyDeltasToObj = function(deltas, obj) {
  for (var key of Object.keys(deltas)) {
    obj[key] += deltas[key];
  }
};

/**
 * Helper for atomicClobbers.
 *
 * We support two clobber styles:
 * 1. Object with keys as simple string key names.
 * 2. Map with keys as list of traversal keys for nested manipulation.
 */
const applyClobbersToObj = function(clobbers, obj) {
  // -- Complex case, map whose keys are paths and values are values.
  if (clobbers instanceof Map) {
    for (let [keyPath, value] of clobbers) {
      let effObj = obj;
      for (let keyPart of keyPath.slice(0, -1)) {
        effObj = effObj[keyPart];
      }
      effObj[keyPath.slice(-1)[0]] = value;
    }
  } else {
    // -- Simple case: object with single string key and value.
    for (let key of Object.keys(clobbers)) {
      obj[key] = clobbers[key];
    }
  }
};

/**
 * Deal with the lack of Array.prototype.values() existing in SpiderMonkey which
 * would let us treat Maps and Arrays identically for the addition case by
 * manually specializing.  We can just use values() once
 * https://bugzilla.mozilla.org/show_bug.cgi?id=875433 is fixed.
 */
function valueIterator(arrayOrMap) {
  if (Array.isArray(arrayOrMap)) {
    return arrayOrMap;
  } else {
    return arrayOrMap.values();
  }
}

const convEventForFolderId = folderId => 'fldr!' + folderId + '!convs!tocChange';
const messageEventForFolderId = folderId => 'fldr!' + folderId + '!messages!tocChange';

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
    idbTransaction.oncomplete = function() {
      resolve();
    };
    idbTransaction.onerror = function(event) {
      reject(analyzeAndLogErrorEvent(event));
    };
  });
}

/**
 * Given an IDBStore and a request map, issue read requests for all the keys
 * in the map with us placing the values in the request map when they complete.
 * Returns the number of requests issued mainly for IndexedDB bug workaround
 * reasons.
 */
function genericUncachedLookups(store, requestMap) {
  let dbReqCount = 0;
  for (let unlatchedKey of requestMap.keys()) {
    let key = unlatchedKey;
    dbReqCount++;
    let req = store.get(key);
    let handler = (event) => {
      let value;
      if (req.error) {
        value = null;
        analyzeAndLogErrorEvent(event);
      } else {
        value = req.result;
      }
      requestMap.set(key, value);
    };
    req.onsuccess = handler;
    req.onerror = handler;
  }
 return dbReqCount;
}

function genericUncachedWrites(trans, tableName, writeMap) {
  if (writeMap) {
    let store = trans.objectStore(tableName);
    for (let [key, value] of writeMap) {
      if (value !== null) {
        store.put(value, key);
      } else {
        store.delete(key);
      }
    }
  }
}

function genericCachedLookups(store, requestMap, cache) {
  let dbReqCount = 0;
  for (let unlatchedKey of requestMap.keys()) {
    let key = unlatchedKey;
    // fill from cache if available
    if (cache.has(key)) {
      requestMap.set(key, cache.get(key));
      continue;
    }

    // otherwise we need to ask the database
    dbReqCount++;
    let req = store.get(key);
    let handler = (event) => {
      if (req.error) {
        analyzeAndLogErrorEvent(event);
      } else {
        let value = req.result;
        // Don't clobber a value in the cache; there might have been a write.
        if (!cache.has(key)) {
          cache.set(key, value);
        }
        requestMap.set(key, value);
      }
    };
    req.onsuccess = handler;
    req.onerror = handler;
  }
  return dbReqCount;
}

/**
 * v3 prototype database.  Intended for use on the worker directly.  For
 * key-encoding efficiency and ease of account-deletion (and for privacy, etc.),
 * we may eventually want to use one account for config and then separate
 * databases for each account.
 *
 * See maildb.md for more info/context.
 *
 * @constructor
 * @memberof module:maildb
 * @param arg
 * @param arg.testOptions
 * @param {Number} [arg.testOptions.dbVersion]
 *   Override the database version to treat as the database version to use.
 *   This is intended to let us do simple database migration testing by
 *   creating the database with an old version number, then re-open it
 *   with the current version and seeing a migration happen.  To test
 *   more authentic migrations when things get more complex, we will
 *   probably want to persist JSON blobs to disk of actual older versions
 *   and then pass that in to populate the database.
 * @param {Boolean} [arg.testOptions.nukeDb]
 *   Compel ourselves to nuke the previous database state and start from
 *   scratch.  This only has an effect when IndexedDB has fired an
 *   onupgradeneeded event.
 *
 */
function MailDB({ universe, testOptions }) {
  evt.Emitter.call(this);
  logic.defineScope(this, 'MailDB');

  this.universe = universe;
  this._db = null;
  /**
   * @type {TriggerManager}
   * We need access to the TriggerManager to directly manipulate its
   * derivedMutations property that database triggers will push manipulations
   * onto.  The TriggerManager clobbers itself onto us when it is initialized
   * for circular dependency reasons.
   */
  this.triggerManager = null;
  /**
   * @type {AccountManager}
   * The AccountManager is the authoritative source of the always-in-memory
   * account definitions and folder infos which are needed for our atomic
   * manipulations of them.  The AccountManager clobbers itself onto us when it
   * is initialized for circular dependency reasons.
   */
  this.accountManager = null;

  this._lazyConfigCarryover = null;

  this.convCache = new Map();
  this.messageCache = new Map();

  let dbVersion = CUR_VERSION;
  if (testOptions && testOptions.dbDelta) {
    dbVersion += testOptions.dbDelta;
  }
  if (testOptions && testOptions.dbVersion) {
    dbVersion = testOptions.dbVersion;
  }
  /**
   * A promise that is resolved once the database has been
   * created/upgraded/opened.  If there is any _lazyConfigCarryover, it will
   * have been set by the time the promise is resolved.
   */
  this._dbPromise = new Promise((resolve, reject) => {
    let openRequest = indexedDB.open('b2g-email', dbVersion);
    openRequest.onsuccess = () => {
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
      // Load the current config, save it off so getConfig can use it, then
      // nuke like usual.  This is obviously a potentially data-lossy approach
      // to things; but this is a 'lazy' / best-effort approach to make us
      // more willing to bump revs during development, not the holy grail.
      else {
        var trans = openRequest.transaction;
        let objectStores = Array.from(db.objectStoreNames);
        // If there is no configuration table, there is nothing to migrate...
        if (objectStores.indexOf(TBL_CONFIG) !== -1) {
          // Note that there is no data-dependency between the read and the
          // nuking.  The nice thing about this is that it allows us to have
          // _getConfig be a promise-wrapped implementation.
          this._getConfig(trans).then((carryover) => {
            if (carryover) {
              carryover.oldVersion = event.oldVersion;
              this._lazyConfigCarryover = carryover;
            }
          });
          this._nukeDB(db);
        }
        // ...so just get nuking.  We call this a failsafe not because we're
        // expecting IndexedDB betrayal, but instead that when I was between
        // linters I made a lot of dumb typo bugs and it's a hassle to manually
        // delete the databases from the profile.
        else {
          logic(this, 'failsafeNuke', { objectStores: objectStores });
          this._nukeDB(db);
        }
      }
    };
    openRequest.onerror = analyzeAndRejectErrorEvent.bind(null, reject);
  });
}

MailDB.prototype = evt.mix(/** @lends module:maildb.MailDB.prototype */ {
  /**
   * Reset the contents of the database.
   */
  _nukeDB(db) {
    logic(this, 'nukeDB', {});
    let existingNames = db.objectStoreNames;
    for (let i = 0; i < existingNames.length; i++) {
      db.deleteObjectStore(existingNames[i]);
    }

    db.createObjectStore(TBL_CONFIG);
    db.createObjectStore(TBL_SYNC_STATES);
    db.createObjectStore(TBL_TASKS);
    db.createObjectStore(TBL_COMPLEX_TASKS);
    db.createObjectStore(TBL_FOLDER_INFO);
    db.createObjectStore(TBL_CONV_INFO);
    db.createObjectStore(TBL_CONV_IDS_BY_FOLDER);
    db.createObjectStore(TBL_MESSAGES);
    db.createObjectStore(TBL_MSG_IDS_BY_FOLDER);
    db.createObjectStore(TBL_HEADER_ID_MAP);
    db.createObjectStore(TBL_UMID_NAME);
    db.createObjectStore(TBL_UMID_LOCATION);
    db.createObjectStore(TBL_BOUNDED_LOGS);
  },

  close() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  },

  getConfig() {
    return this._dbPromise.then(() => {
      // At this point, if there is any carryover, it's in this property here.
      if (this._lazyConfigCarryover) {
        let carryover = this._lazyConfigCarryover;
        this._lazyConfigCarryover = null;
        return { config: null, accountDefs: null, carryover };
      }
      return this._getConfig();
    });
  },

  /**
   * Retrieve the configuration from the database.  This does not use promises
   * and is otherwise somewhat convoluted because we have two different callers:
   * 1) Standard: The MailUniverse wants a Promise resolved with our state.
   * 2) Upgrade: We call ourselves inside onupgradeneeded.  Because the
   *    IndexedDB transaction model is not (currently) compatible with promises
   *    as specified and implemented, we need to generate callbacks so that we
   *
   * Additionally, in the first/standard case, in the event we did perform an
   * upgrade, this is the point at which we pass the saved-off
   */
  _getConfig(trans) {
    logic(this, '_getConfig', { trans: !!trans });
    let transaction = trans ||
                      this._db.transaction([TBL_CONFIG], 'readonly');
    let configStore = transaction.objectStore(TBL_CONFIG);

    return wrapReq(configStore.getAll()).then((configRows) => {
      let config = null;
      let accountDefs = [];

      // - Process the results
      for (let i = 0; i < configRows.length; i++) {
        let obj = configRows[i];
        if (obj.id === 'config') {
          config = obj;
        } else {
          accountDefs.push(obj);
        }
      }

      return { config, accountDefs };
    });
  },

  /**
   * Save our global configuration.  This is the *only* write that happens
   * outside of the task transaction model using `finishMutate` and friends.
   * Note, however, that various reads (including the accountDefs) happen
   * outside of that.
   */
  saveConfig(config) {
    return wrapTrans(
      this._db.transaction(TBL_CONFIG, 'readwrite')
              .objectStore(TBL_CONFIG)
              .put(config, 'config'));
  },

  /**
   * Save the addition of a new account or when changing account settings.  Only
   * pass `folderInfo` for the new account case; omit it for changing settings
   * so it doesn't get updated.  For coherency reasons it should only be updated
   * using saveAccountFolderStates.
   */
  saveAccountDef(config, accountDef, folderInfo, callback) {
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
   * Add one or more new bounded-log entries to disk outside of a task.  Entries
   * should take the form of { timestamp, type, id, entry }.
   */
  addBoundedLogs(entries) {
    let trans = this._db.transaction(TBL_BOUNDED_LOGS, 'readwrite');
    let store = trans.objectStore(TBL_BOUNDED_LOGS);

    for (let entry of entries) {
      store.add(entry.entry, [entry.timestamp, entry.type, entry.id]);
    }

    return wrapTrans(trans);
  },

  /**
   * Update one or more existing bounded-log entries to disk.  Entries should
   * take the form of { timestamp, type, id, entry }.
   */
  updateBoundedLogs(entries) {
    let trans = this._db.transaction(TBL_BOUNDED_LOGS, 'readwrite');
    let store = trans.objectStore(TBL_BOUNDED_LOGS);

    for (let entry of entries) {
      store.put(entry.entry, [entry.timestamp, entry.type, entry.id]);
    }

    return wrapTrans(trans);
  },

  /**
   * Reap bounded logs beyond our keep time horizon.
   */
  reapOldBoundedLogs() {
    let trans = this._db.transaction(TBL_BOUNDED_LOGS, 'readwrite');
    let store = trans.objectStore(TBL_BOUNDED_LOGS);

    let deleteRange = IDBKeyRange.bound(
      // Start at the dawn of time.
      [0],
      // And delete through 2 weeks ago or whatever or constant is.
      [Date.now() - BOUNDED_LOG_KEEP_TIME_MILLIS, []],
      true, true);

      store.delete(deleteRange);

    return wrapTrans(trans);
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
  _considerCachePressure(/*why, ctx*/) {
    // XXX memory-backed Blobs are being a real pain.  So let's start
    // aggressively dropping the cache.  But because of how promises work and
    // when we trigger this, we really want to use a setTimeout with a fixed
    // delay so we don't nuke the cache out from under a read() caller before
    // they are able to handle the data.
    // TODO: potentially consider allowing some concept of providing a promise
    // as a cache-nuking barrier.  We would accept the promise and a blame label
    // and create a racing timer (promise?) that would generate an error and
    // then perform the flush despite the promise.  (The primary goal is to
    // avoid infinite read() loops like was happening without this setTimeout
    // where list view logic was being defeated given its ordering assumptions
    // and steady-state design that relies on the cache.)
    if (this._emptyingCache) {
      return;
    }
    this._emptyingCache = globalThis.setTimeout(
      () => {
        this._emptyingCache = null;
        this.emptyCache();
      },
      // This need not actually be 100. But just doing Promise.resolve().then
      // here would not be sufficient for correctness.  setTimeout(0) would
      // probably be okay.  This here give us some locality, however.
      100);
  },

  emptyCache() {
    this.emit('cacheDrop');

    this.convCache.clear();
    this.messageCache.clear();
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
  _bufferChangeEventsIdiom(eventId) {
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
      drainEvents,
      eventId,
    };
  },

  /**
   * Issue read-only batch requests.
   *
   * @param ctx
   * @param {Object} requests
   *   A dictionary object of Maps whose keys are record identifiers and values
   *   are initially null but will be filled in by us (if we can find the
   *   record).  See the specific
   * @param {Map<ConversationId, ConversationInfo>} requests.conversations
   *   Load the given ConversationInfo structure.
   * @param {Map<ConversationId, MessageInfo[]>} requests.messagesByConversation
   *   Load all of the known messages for the given conversation, returning an
   *   array ordered by the database storage order which is ascending by DateMS
   *   and the encoded gmail message id.  Note that this mechanism currently
   *   cannot take advantage of the `messageCache`.  (There are some easy-ish
   *   things we could do to accomplish this, but it's not believed to be a
   *   major concern at this time.)
   * @param {Map<[MessageId, DateMS], MessageInfo>} requests.messages
   *   Load specific messages.  Note that we need the canonical MessageId plus
   *   the DateMS associated with the message to find the record if it's not in
   *   cache.  This is a little weird but it's assumed you have previously
   *   loaded the (now potentially stale) MessageInfo and so have the
   *   information at hand.
   * @param {Boolean} [requests.flushedMessageReads=false]
   *   Should this read bypass the cache when reading and when read, clobber
   *   the cache state?  This should only be done for Blob-memory-shenanigans
   *   and should be done with a (de facto) mutate lock held.  Currently, to
   *   ensure the Blobs propagate, a final write should occur which is a
   *   redudnant write so that listeners are notified.  But in the future we
   *   could enhance this by just generating change notifications on the read.
   */
  read(ctx, requests) {
    return new Promise((resolve) => {
      logic(this, 'read:begin', { ctxId: ctx.id });
      let trans = this._db.transaction(TASK_MUTATION_STORES, 'readonly');

      let dbReqCount = 0;

      // -- In-memory lookups
      if (requests.config) {
        requests.config = this.universe.config;
      }
      if (requests.accounts) {
        let accountReqs = requests.accounts;
        for (let accountId of accountReqs.keys()) {
          accountReqs.set(
            accountId, this.accountManager.getAccountDefById(accountId));
        }
      }
      if (requests.folders) {
        let folderReqs = requests.folders;
        for (let folderId of folderReqs.keys()) {
          folderReqs.set(
            folderId, this.accountManager.getFolderById(folderId));
        }
      }

      // -- Uncached lookups
      // Note that being uncached isn't actually netting us any correctness
      // wins since our mutating transactions don't live for the duration for
      // which a mutation lock needs to be held.  These are all candidates for
      // caching in the future if we end up caring.
      if (requests.syncStates) {
        dbReqCount += genericUncachedLookups(
          trans.objectStore(TBL_SYNC_STATES),
          requests.syncStates);
      }
      if (requests.headerIdMaps) {
        dbReqCount += genericUncachedLookups(
          trans.objectStore(TBL_HEADER_ID_MAP),
          requests.headerIdMaps);
      }
      if (requests.umidNames) {
        dbReqCount += genericUncachedLookups(
          trans.objectStore(TBL_UMID_NAME),
          requests.umidNames);
      }
      if (requests.umidLocations) {
        dbReqCount += genericUncachedLookups(
          trans.objectStore(TBL_UMID_LOCATION),
          requests.umidLocations);
      }
      if (requests.complexTaskStates) {
        dbReqCount += genericUncachedLookups(
          trans.objectStore(TBL_COMPLEX_TASKS),
          requests.complexTaskStates);
      }

      // -- Cached lookups
      if (requests.conversations) {
        dbReqCount += genericCachedLookups(
          trans.objectStore(TBL_CONV_INFO),
          requests.conversations,
          this.convCache);
      }
      // messagesByConversation requires special logic and can't use the helpers
      if (requests.messagesByConversation) {
        let messageStore = trans.objectStore(TBL_MESSAGES);
        let messageCache = this.messageCache;
        let requestsMap = requests.messagesByConversation;

        for (let unlatchedConvId of requestsMap.keys()) {
          let convId = unlatchedConvId;
          let messageRange = IDBKeyRange.bound([convId],
                                               [convId, []],
                                               true, true);
          dbReqCount++;
          let req = messageStore.getAll(messageRange);
          let handler = (event) => {
            if (req.error) {
              analyzeAndLogErrorEvent(event);
            } else {
              let messages = req.result;
              for (let message of messages) {
                // Put it in the cache unless it's already there (reads must
                // not clobber writes/mutations!)
                // NB: This does mean that there's potential inconsistency
                // problems for this reader in the event the cache does know the
                // message and the values are not the same.
                // TODO: lock that down with checks or some fancy thinkin'
                if (!messageCache.has(message.id)) {
                  messageCache.set(message.id, message);
                }
              }
              requestsMap.set(convId, messages);
            }
          };
          req.onsuccess = handler;
          req.onerror = handler;
        }
      }
      // messages requires special logic and can't use the helpers
      if (requests.messages) {
        let messageStore = trans.objectStore(TBL_MESSAGES);
        let messageCache = this.messageCache;
        // The requests have keys for the form [messageId, date], but we want
        // the results to be more sane, keyed by just the messageId and without
        // the awkward tuples.
        let messageRequestsMap = requests.messages;
        let messageResultsMap = requests.messages = new Map();
        let flushedRead = requests.flushedMessageReads || false;
        for (let [unlatchedMessageId, date] of messageRequestsMap.keys()) {
          let messageId = unlatchedMessageId;
          // fill from cache if available
          if (!flushedRead && messageCache.has(messageId)) {
            messageResultsMap.set(messageId, messageCache.get(messageId));
            continue;
          }

          // otherwise we need to ask the database
          let key = [
            convIdFromMessageId(messageId),
            date,
            messageSpecificIdFromMessageId(messageId)
          ];
          dbReqCount++;
          let req = messageStore.get(key);
          let handler = (event) => {
            if (req.error) {
              analyzeAndLogErrorEvent(event);
            } else {
              let message = req.result;
              // Put it in the cache unless it's already there (reads must
              // not clobber writes/mutations!)
              if (flushedRead || !messageCache.has(messageId)) {
                messageCache.set(messageId, message);
              }
              messageResultsMap.set(messageId, message);
            }
          };
          req.onsuccess = handler;
          req.onerror = handler;
        }
      }

      if (!dbReqCount) {
        // NB: We used to have to issue a wasted read here to avoid hanging the
        // transactions due to an IndexedDB bug, tracked as
        // https://bugzilla.mozilla.org/show_bug.cgi?id=1161690.  It apparently
        // got fixed by something (not the Promises fix, though), so I'm
        // commenting the logic out.  We should remove this comment and the
        // commented-out code here if nothing recurs by mid-September 2015.
        //trans.objectStore(TBL_CONFIG).get('doesnotexist');
        //console.warn('creating useless read to avoid hanging IndexedDB');
        resolve(requests);
        // it would be nice if we could have avoided creating the transaction...
      } else {
        trans.oncomplete = () => {
          logic(this, 'read:end', { ctxId: ctx.id, dbReqCount });
          resolve(requests);
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
  beginMutate(ctx, mutateRequests, options) {
    // disabling guard here because TaskContext has protections and a cop-out.
    /*
    if (ctx._preMutateStates) {
      throw new Error('Context already has mutation states tracked?!');
    }
    */

    return this.read(ctx, mutateRequests, options).then(() => {
      // XXX the _preMutateStates || {} is because we're allowing multiple
      // calls.
      let preMutateStates = ctx._preMutateStates = (ctx._preMutateStates || {});

      // (nothing to do for "syncStates")
      // (nothing to do for "accounts")
      // (nothing to do for "folders")

      // - conversations
      if (mutateRequests.conversations) {
        let preConv = preMutateStates.conversations = new Map();
        for (let conv of mutateRequests.conversations.values()) {
          if (!conv) {
            // It's conceivable for the read to fail, and it will already have
            // logged.  So just skip any explosions here.
            continue;
          }

          preConv.set(
            conv.id,
            {
              date: conv.date,
              // A well-behaved mutation will not mutate the list and instead
              // replace it with a new one, but we are not so naive as to
              // have our correctness depend on that.
              folderIds: new Set(conv.folderIds),
              hasUnread: conv.hasUnread,
              height: conv.height
            });
        }
      }

      // - messages
      // we need the date for all messages, whether directly loaded or loaded
      // via messagesByConversation
      if (mutateRequests.messagesByConversation ||
          mutateRequests.messages) {
        let preMessages = preMutateStates.messages = new Map();

        if (mutateRequests.messagesByConversation) {
          for (let convMessages of
               mutateRequests.messagesByConversation.values()) {
            for (let message of convMessages) {
              preMessages.set(
                message.id,
                {
                  date: message.date,
                  folderIds: new Set(message.folderIds)
                });
            }
          }
        }
        if (mutateRequests.messages) {
          for (let message of mutateRequests.messages.values()) {
            preMessages.set(
              message.id,
              {
                date: message.date,
                folderIds: new Set(message.folderIds)
              });
          }
        }
      }

      return mutateRequests;
    });
  },

  /**
   * Load all tasks from thew database.  Ideally this is called before any calls
   * to addTasks if you want to avoid having a bad time.
   */
  loadTasks() {
    let trans = this._db.transaction(
      [TBL_TASKS, TBL_COMPLEX_TASKS], 'readonly');
    let taskStore = trans.objectStore(TBL_TASKS);
    let complexTaskStore = trans.objectStore([TBL_COMPLEX_TASKS]);
    return Promise.all(
      [wrapReq(taskStore.getAll()), wrapReq(complexTaskStore.getAllKeys()),
       wrapReq(complexTaskStore.getAll())])
    .then(([wrappedTasks, complexTaskStateKeys, complexTaskStateValues]) => {
      return {
        wrappedTasks,
        complexTaskStates: [complexTaskStateKeys, complexTaskStateValues]
      };
    });
  },

  /**
   * Load all the folders for an account.  This is intended to be used only by
   * the AccountManager exactly once when it learns about an account.  After
   * that, the canonical data is stored in memory by the AccountManager with
   * write-through mutations occurring.  (Noting that the MailDB does
   * automatically defer to the AccountManager for read requests via other
   * helpers.)
   */
  loadFoldersByAccount(accountId) {
    let trans = this._db.transaction(TBL_FOLDER_INFO, 'readonly');
    let store = trans.objectStore(TBL_FOLDER_INFO);
    let accountStringPrefix = IDBKeyRange.bound(
      accountId + '.',
      accountId + '.\ufff0',
      true, true);
    return wrapReq(store.getAll(accountStringPrefix));
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
  async loadFolderConversationIdsAndListen(folderId) {
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
    let tuples = await wrapReq(convIdsStore.getAll(folderRange));
    logic(this, 'loadFolderConversationIdsAndListen',
          { convCount: tuples.length, eventId: retval.eventId });

    // These are sorted in ascending order, but we want them in descending
    // order.
    tuples.reverse();
    retval.idsWithDates = tuples.map(function(x) {
      return { date: x[1], id: x[2], height: x[3] };
    });
    return retval;
  },

  _processConvAdditions(trans, convs) {
    let convStore = trans.objectStore(TBL_CONV_INFO);
    let convIdsStore = trans.objectStore(TBL_CONV_IDS_BY_FOLDER);
    for (let convInfo of valueIterator(convs)) {
      convStore.add(convInfo, convInfo.id);
      this.convCache.set(convInfo.id, convInfo);

      const eventDeltaInfo = {
        id: convInfo.id,
        item: convInfo,
        removeDate: null,
        addDate: convInfo.date,
        height: convInfo.height,
        oldHeight: 0
      };
      for (let folderId of convInfo.folderIds) {
        this.emit('conv!*!add', convInfo);
        this.emit(convEventForFolderId(folderId), eventDeltaInfo);

        convIdsStore.add(
          [folderId, convInfo.date, convInfo.id, convInfo.height], // value
          [folderId, convInfo.date, convInfo.id]); // key
      }
    }
  },

  /**
   * Process changes to conversations.  This does not cover additions, but it
   * does cover deletion.
   */
  _processConvMutations(trans, preStates, convs) {
    let convStore = trans.objectStore(TBL_CONV_INFO);
    let convIdsStore = trans.objectStore(TBL_CONV_IDS_BY_FOLDER);
    for (let [convId, convInfo] of convs) {
      let preInfo = preStates.get(convId);

      // We do various folder-spcific things below; to allow for simplficiations
      // under deletion of the conversation, we have a helper here so that even
      // if convInfo is null, we can have an empty set for its folderIds that
      // will not result in a null de-ref.
      let convFolderIds;
      // -- Deletion
      if (convInfo === null) {
        // - Delete the conversation summary
        convStore.delete(convId);
        this.convCache.delete(convId);

        // - The new folder set is the empty set
        // This simplifies all the logic below.
        convFolderIds = new Set();

        // - Delete all affiliated messages
        // TODO: uh, we should explicitly nuke the messages out of the cache
        // too.  There isn't a huge harm to not doing it, but we should.
        // (I'm punting because we need to do a cache walk to accomplish this.)
        let messageRange = IDBKeyRange.bound([convId],
                                             [convId, []],
                                             true, true);

        trans.objectStore(TBL_MESSAGES).delete(messageRange);
      } else { // Modification
        convFolderIds = convInfo.folderIds;
        convStore.put(convInfo, convId);
        this.convCache.set(convId, convInfo);
      }

      // Notify specific listeners, and yeah, deletion is just telling a null
      // value.
      this.emit('conv!' + convId + '!change', convId, convInfo);

      let { added, kept, removed } =
        computeSetDelta(preInfo.folderIds, convFolderIds);

      // Notify wildcard listeners (probably db_triggers implementations)
      this.emit('conv!*!change', convId, preInfo, convInfo, added, kept,
                removed);

      // Notify the TOCs
      for (let folderId of added) {
        this.emit(convEventForFolderId(folderId),
                  {
                    id: convId,
                    item: convInfo,
                    removeDate: null,
                    addDate: convInfo.date,
                    height: convInfo.height,
                    oldHeight: 0
                  });
      }
      // (We still want to generate an event even if there is no date change
      // since otherwise the TOC won't know something has changed.)
      for (let folderId of kept) {
        this.emit(convEventForFolderId(folderId),
                  {
                    id: convId,
                    item: convInfo,
                    removeDate: preInfo.date,
                    addDate: convInfo.date,
                    height: convInfo.height,
                    oldHeight: preInfo.height
                  });
      }
      for (let folderId of removed) {
        this.emit(convEventForFolderId(folderId),
                  {
                    id: convId,
                    item: convInfo,
                    removeDate: preInfo.date,
                    addDate: null,
                    height: 0,
                    oldHeight: preInfo.height
                  });
      }

      // If this is a conversation deletion, the most recent message date
      // changed or the height changed, we need to blow away all the existing
      // mappings and all the mappings are new anyways.
      if (!convInfo ||
          preInfo.date !== convInfo.date ||
          preInfo.height !== convInfo.height) {
        for (let folderId of preInfo.folderIds) {
          convIdsStore.delete([folderId, preInfo.date, convId]);
        }
        // If this wasn't a deletion, add the updated info back.
        if (convInfo) {
          for (let folderId of convFolderIds) {
            convIdsStore.add(
              [folderId, convInfo.date, convId, convInfo.height], // value
              [folderId, convInfo.date, convId]); // key
          }
        }
      }
      // Otherwise we need to cleverly compute the delta
      else {
        for (let folderId of removed) {
          convIdsStore.delete([folderId, convInfo.date, convId]);
        }
        for (let folderId of added) {
          convIdsStore.add(
            [folderId, convInfo.date, convId, convInfo.height], // value
            [folderId, convInfo.date, convId]); // key
        }
      }
    }
  },

  async loadFolderMessageIdsAndListen(folderId) {
    let eventId = 'fldr!' + folderId + '!messages!tocChange';
    let retval = this._bufferChangeEventsIdiom(eventId);

    let trans = this._db.transaction(TBL_MSG_IDS_BY_FOLDER, 'readonly');
    let msgIdsStore = trans.objectStore(TBL_MSG_IDS_BY_FOLDER);
    // [folderId] lower-bounds all [FolderId, DateTS, ...] keys because a
    // shorter array is by definition less than a longer array that is equal
    // up to their shared length.
    // [folderId, []] upper-bounds all [FolderId, DateTS, ...] because arrays
    // are always greater than strings/dates/numbers.  So we use this idiom
    // to simplify our lives for sanity purposes.
    let folderRange = IDBKeyRange.bound([folderId], [folderId, []],
                                        true, true);
    let tuples = await wrapReq(msgIdsStore.getAll(folderRange));
    logic(this, 'loadFolderMessageIdsAndListen',
          { msgCount: tuples.length, eventId: retval.eventId });

    // These are sorted in ascending order, but we want them in descending
    // order.
    tuples.reverse();
    retval.idsWithDates = tuples.map(function(x) {
      return { date: x[1], id: x[2] };
    });
    return retval;
  },

  async loadConversationMessageIdsAndListen(convId) {
    let tocEventId = 'conv!' + convId + '!messages!tocChange';
    let convEventId = 'conv!' + convId + '!change';
    let { drainEvents } = this._bufferChangeEventsIdiom(tocEventId);

    let trans = this._db.transaction(TBL_MESSAGES, 'readonly');
    let messageStore = trans.objectStore(TBL_MESSAGES);
    let messageRange = IDBKeyRange.bound([convId], [convId, []],
                                         true, true);
    let messages = await wrapReq(messageStore.getAll(messageRange));
    let messageCache = this.messageCache;
    let idsWithDates = messages.map(function(message) {
      // Put it in the cache unless it's already there (reads must
      // not clobber writes/mutations!)
      if (!messageCache.has(message.id)) {
        messageCache.set(message.id, message);
      }
      return { date: message.date, id: message.id };
    });
    return { tocEventId, convEventId, idsWithDates, drainEvents };
  },

  _processMessageAdditions(trans, messages) {
    let store = trans.objectStore(TBL_MESSAGES);
    let idsStore = trans.objectStore(TBL_MSG_IDS_BY_FOLDER);
    let messageCache = this.messageCache;
    for (let message of valueIterator(messages)) {
      let convId = convIdFromMessageId(message.id);
      let key = [
        convId,
        message.date,
        messageSpecificIdFromMessageId(message.id)
      ];
      store.add(message, key);
      messageCache.set(message.id, message);

      this.emit('msg!*!add', message);
      const convTocEventId = 'conv!' + convId + '!messages!tocChange';
      const eventDeltaInfo = {
        id: message.id,
        preDate: null,
        postDate: message.date,
        item: message,
        freshlyAdded: true,
        matchInfo: null
      };
      this.emit(convTocEventId, eventDeltaInfo);
      // emit in all its folders as well
      for (const folderId of message.folderIds) {
        this.emit(messageEventForFolderId(folderId), eventDeltaInfo);

        // TODO: As covered elsewhere, we want to remove the redundant value
        // if possible, although if we end up storing more data in the value,
        // we may not be able to.
        idsStore.add(
          [folderId, message.date, message.id], // value
          [folderId, message.date, message.id], // key
        );
      }
    }
  },

  /**
   * Process message modification and removal.
   */
  _processMessageMutations(trans, preStates, messages) {
    let store = trans.objectStore(TBL_MESSAGES);
    let idsStore = trans.objectStore(TBL_MSG_IDS_BY_FOLDER);
    let messageCache = this.messageCache;
    for (let [messageId, message] of messages) {
      let convId = convIdFromMessageId(messageId);
      let preInfo = preStates.get(messageId);
      let preDate = preInfo.date;
      let postDate = message && message.date;
      let preKey = [
        convId,
        preDate,
        messageSpecificIdFromMessageId(messageId)
      ];

      if (message === null) {
        // -- Deletion
        store.delete(preKey);
        messageCache.delete(messageId);
      } else if (preDate !== postDate) {
        // -- Draft update that changes the timestamp
        store.delete(preKey);
        let postKey = [
          convId,
          postDate,
          messageSpecificIdFromMessageId(messageId)
        ];
        store.put(message, postKey);
      } else {
        // -- Modification without date change
        store.put(message, preKey);
        messageCache.set(messageId, message);
      }

      let { added, kept, removed } =
        computeSetDelta(
          preInfo.folderIds, message ? message.folderIds : new Set());

      let convEventId = 'conv!' + convId + '!messages!tocChange';
      this.emit(
        convEventId,
        {
          id: messageId,
          preDate,
          postDate,
          item: message,
          freshlyAdded: false,
          matchInfo: null
        });
      let messageEventId = 'msg!' + messageId + '!change';
      this.emit(messageEventId, messageId, message);

      for (const folderId of added) {
        this.emit(
          messageEventForFolderId(folderId),
          {
            id: messageId,
            preDate,
            postDate,
            item: message,
            freshlyAdded: true,
            matchInfo: null
          });
      }
      for (const folderId of kept) {
        this.emit(
          messageEventForFolderId(folderId),
          {
            id: messageId,
            preDate,
            postDate,
            item: message,
            freshlyAdded: false,
            matchInfo: null
          });
      }
      for (const folderId of removed) {
        this.emit(
          messageEventForFolderId(folderId),
          {
            id: messageId,
            preDate,
            postDate,
            item: message,
            freshlyAdded: false,
            matchInfo: null
          });
      }

      this.emit(
        'msg!*!change', messageId, preInfo, message, added, kept, removed);
      if (!message) {
        this.emit('msg!' + messageId + '!remove', messageId);
        this.emit('msg!*!remove', messageId);
      }

      // -- Cleanup the by-folder derived quasi-index
      // Handle deletions and changes in the data payload
      if (!message ||
          preDate !== postDate) {
        for (const folderId of preInfo.folderIds) {
          idsStore.delete([folderId, preInfo.date, messageId]);
        }
        // If this wasn't a deletion, add the updated info back.
        if (message) {
          for (const folderId of message.folderIds) {
            idsStore.add(
              [folderId, message.date, message.id], // value
              [folderId, message.date, message.id], // key
            );
          }
        }
      }
      // Effect any change in folderIds
      else {
        for (const folderId of removed) {
          idsStore.delete([folderId, message.date, messageId]);
        }
        for (const folderId of added) {
          idsStore.add(
            [folderId, message.date, message.id], // value
            [folderId, message.date, message.id], // key
          );
        }
      }
    }
  },

  /**
   * Apply the atomicClobbers and atomicDeltas fields from the given mutation
   * objects.  We are applied against both the task's explicit mutations payload
   * plus also any derivedMutations provided by database triggers.
   *
   * As described elsewhere, all of the data that atomic manipulations mess with
   * will be in-memory before any tasks are allowed to run.  The AccountManager
   * is in charge of them, so we ask it for the fields.
   *
   * @param {Object} atomics
   *   The atomic manipulations to perform.  This could be the same as
   *   rootMutations if specified by the task, or could be a separate object
   *   contributed by a database trigger implementation.
   * @param {Object} [atomics.atomicDeltas]
   * @param {Object} [atomics.atomicDeltas.accounts]
   * @param {Object} [atomics.atomicDeltas.folders]
   * @param {Object} [atomics.atomicClobbers]
   * @param {Object} [atomics.atomicClobbers.config]
   * @param {Object} [atomics.atomicClobbers.accounts]
   * @param {Object} [atomics.atomicClobbers.folders]
   * @param {Object} rootMutations
   *   The root mutations object passed to finishMutate.  In order to create
   *   a unified set of writes, we will manipulate existing accounts and folders
   *   write Maps, or if they do not exist, we will create them ourselves.
   *   Correctness fundamentally requires that if these are mutations that the
   *   AccountManager-owned object identities are maintained.  (Which is on the
   *   task/caller.)
   */
  _applyAtomics(atomics, rootMutations) {
    let { atomicDeltas, atomicClobbers } = atomics;
    const accountManager = this.accountManager;
    if (atomicDeltas) {
      if (atomicDeltas.config) {
        if (!rootMutations.config) {
          rootMutations.config = this.universe.config;
        }
        applyDeltasToObj(atomicDeltas.config, rootMutations.config);
      }
      if (atomicDeltas.accounts) {
        if (!rootMutations.accounts) {
          rootMutations.accounts = new Map();
        }
        let accountMutations = rootMutations.accounts;
        for (let [accountId, deltas] of atomicDeltas.accounts) {
          let accountDef = accountManager.getAccountDefById(accountId);
          applyDeltasToObj(deltas, accountDef);
          accountMutations.set(accountId, accountDef);
        }
      }
      if (atomicDeltas.folders) {
        if (!rootMutations.folders) {
          rootMutations.folders = new Map();
        }
        let folderMutations = rootMutations.folders;
        for (let [folderId, deltas] of atomicDeltas.folders) {
          let folder = accountManager.getFolderById(folderId);
          applyDeltasToObj(deltas, folder);
          folderMutations.set(folderId, folder);
        }
      }
    }
    if (atomicClobbers) {
      if (atomicClobbers.config) {
        if (!rootMutations.config) {
          rootMutations.config = this.universe.config;
        }
        applyClobbersToObj(atomicClobbers.config, rootMutations.config);
      }
      if (atomicClobbers.accounts) {
        if (!rootMutations.accounts) {
          rootMutations.accounts = new Map();
        }
        let accountMutations = rootMutations.accounts;
        for (let [accountId, clobbers] of atomicClobbers.accounts) {
          let accountDef = accountManager.getAccountDefById(accountId);
          applyClobbersToObj(clobbers, accountDef);
          accountMutations.set(accountId, accountDef);
        }
      }
      if (atomicClobbers.folders) {
        if (!rootMutations.folders) {
          rootMutations.folders = new Map();
        }
        let folderMutations = rootMutations.folders;
        for (let [folderId, clobbers] of atomicClobbers.folders) {
          let folder = accountManager.getFolderById(folderId);
          applyClobbersToObj(clobbers, folder);
          folderMutations.set(folderId, folder);
        }
      }
    }
  },

  _processAccountDeletion(trans, accountId) {
    // Build a range that covers our family of keys where we use an
    // array whose first item is a string id that is a concatenation of
    // `AccountId`, the string ".", and then some more array parts.  Our
    // prefix string provides a lower bound, and the prefix with the
    // highest possible unicode character thing should be strictly
    // greater than any legal suffix (\ufff0 not being a legal suffix
    // in our key-space.)
    let accountStringPrefix = IDBKeyRange.bound(
      accountId + '.',
      accountId + '.\ufff0',
      true, true);
    // A key range where the key is an array and the first item is a string that
    // is a namespaced-suffix of the accountId.  For example, FolderId and
    // ConversationId and MessageId are all suffixes.  If the first item is
    // *only* the accountId,
    let accountArrayItemPrefix = IDBKeyRange.bound(
      [accountId + '.'],
      [accountId + '.\ufff0'],
      true, true);
    // A key range where the key is an array and the first item is the
    // AccountId.
    let accountFirstElementArray = IDBKeyRange.bound(
      [accountId],
      // We use an array as the second element since arrays are greater than
      // all other key values.  We do this instead of suffixing the (variable
      // length) AccountId because although this way is slightly more magic,
      // I believe it's significantly easier to intuitively understand as
      // correct.  If only because everyone should be innately terrified of
      // string comparisons and unicode.  (It does, however forbid any of our
      // data types from using nested arrays as the second element.  This is
      // currently the case.)
      [accountId, []],
      true, true);

    // We handle the syncStates, folders, conversations, and message
    // ranges here.
    // Task fallout needs to be explicitly managed by the task in
    // coordination with the TaskManager.
    trans.objectStore(TBL_CONFIG)
      .delete(CONFIG_KEYPREFIX_ACCOUNT_DEF + accountId);

    // Sync state: delete the accountId and any delimited suffixes
    trans.objectStore(TBL_SYNC_STATES).delete(accountId);
    trans.objectStore(TBL_SYNC_STATES).delete(accountStringPrefix);

    trans.objectStore(TBL_COMPLEX_TASKS).delete(accountFirstElementArray);

    // Folders: Just delete by accountId
    trans.objectStore(TBL_FOLDER_INFO).delete(accountStringPrefix);

    // Conversation: string ordering unicode tricks
    trans.objectStore(TBL_CONV_INFO).delete(accountStringPrefix);
    trans.objectStore(TBL_CONV_IDS_BY_FOLDER).delete(
      accountArrayItemPrefix);

    // Messages: string ordering unicode tricks
    trans.objectStore(TBL_MESSAGES).delete(accountArrayItemPrefix);
    trans.objectStore(TBL_MSG_IDS_BY_FOLDER).delete(
      accountArrayItemPrefix);

    trans.objectStore(TBL_HEADER_ID_MAP).delete(accountFirstElementArray);
    trans.objectStore(TBL_UMID_LOCATION).delete(accountStringPrefix);
    trans.objectStore(TBL_UMID_NAME).delete(accountStringPrefix);
  },

  _addRawTasks(trans, wrappedTasks) {
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
  addTasks(wrappedTasks) {
    let trans = this._db.transaction([TBL_TASKS], 'readwrite');
    this._addRawTasks(trans, wrappedTasks);
    return wrapTrans(trans);
  },

  /**
   * Dangerously perform a write in a write transaction that's not part of a
   * coherent/atomic change.  This is intended to be used *ONLY* for the
   * write-blob-then-read-blob idiom and only for messages.  Pre-mutate-state
   * must have been saved off already for message id naming purposes.
   *
   * This method may be replaced by a single write-then-read implementation that
   * does better with event emitting to minimize wackiness, but right now it's
   * on the caller to issue the flushed read and we expose the constituent
   * methods as a sort-of experiment as we iterate.
   */
  dangerousIncrementalWrite(ctx, mutations) {
    logic(this, 'dangerousIncrementalWrite:begin', { ctxId: ctx.id });
    let trans = this._db.transaction(TASK_MUTATION_STORES, 'readwrite');

    if (mutations.messages) {
      this._processMessageMutations(
        trans, ctx._preMutateStates.messages, mutations.messages);
    }

    return wrapTrans(trans).then(() => {
      logic(this, 'dangerousIncrementalWrite:end', { ctxId: ctx.id });
    });
  },

  finishMutate(ctx, data, taskData) {
    logic(this, 'finishMutate:begin', { ctxId: ctx.id });
    let trans = this._db.transaction(TASK_MUTATION_STORES, 'readwrite');

    // The TriggerManager needs context for the events we will be
    // (synchronously, unawaitingly) firing.  We clear the state below.
    let derivedMutations = [];
    this.triggerManager.__setState(ctx, derivedMutations);

    // -- New / Added data
    let newData = data.newData;
    if (newData) {
      if (newData.accounts) {
        for (let accountDef of newData.accounts) {
          trans.objectStore(TBL_CONFIG)
            .put(accountDef, CONFIG_KEYPREFIX_ACCOUNT_DEF + accountDef.id);
          this.emit('accounts!tocChange', accountDef.id, accountDef, true);
        }
      }
      if (newData.folders) {
        let store = trans.objectStore(TBL_FOLDER_INFO);
        for (let folderInfo of newData.folders) {
          let accountId = accountIdFromFolderId(folderInfo.id);
          store.put(folderInfo, folderInfo.id);
          this.emit(`acct!${accountId}!folders!tocChange`,
                    folderInfo.id, folderInfo, true);
        }
      }
      if (newData.conversations) {
        this._processConvAdditions(trans, newData.conversations);
      }
      if (newData.messages) {
        this._processMessageAdditions(trans, newData.messages);
      }
      // newData.tasks is transformed by the TaskContext into
      // taskData.wrappedTasks
    }

    // -- Mutations (begun via beginMutate)
    let mutations = data.mutations;
    if (mutations) {
      genericUncachedWrites(trans, TBL_SYNC_STATES, mutations.syncStates);
      genericUncachedWrites(trans, TBL_HEADER_ID_MAP, mutations.headerIdMaps);
      genericUncachedWrites(trans, TBL_UMID_NAME, mutations.umidNames);
      genericUncachedWrites(trans, TBL_UMID_LOCATION, mutations.umidLocations);

      if (mutations.conversations) {
        this._processConvMutations(
          trans, ctx._preMutateStates.conversations, mutations.conversations);
      }

      if (mutations.messages) {
        this._processMessageMutations(
          trans, ctx._preMutateStates.messages, mutations.messages);
      }

      // complexTaskStates are committed after merging in trigger side-effects.
    } else {
      // atomics potentially need this.
      mutations = {};
    }

    // Clear state; triggers have had their chance already, no point adding
    // confusion.
    this.triggerManager.__clearState();

    // -- Atomics
    this._applyAtomics(data, mutations);
    if (derivedMutations.length) {
      for (let derivedMut of derivedMutations) {
        this._applyAtomics(derivedMut, mutations);

        // - Merge in complex task states.
        // (It's very possible for a task-based trigger to fire multiple times
        // in a single transaction.  In that case, there will be redundant state
        // writes being made )
        if (derivedMut.complexTaskStates) {
          if (!mutations.complexTaskStates) {
            mutations.complexTaskStates = new Map();
          }
          for (let [key, value] of derivedMut.complexTaskStates) {
            mutations.complexTaskStates.set(key, value);
          }
        }

        // TODO: allow database triggers to contribute tasks too.
        // sorta resolved by the rootGroupDeferredTask mechanism here...

        if (derivedMut.rootGroupDeferredTask) {
          ctx.ensureRootTaskGroupFollowOnTask(derivedMut.rootGroupDeferredTask);
        }
      }
    }

    // -- Atomics-controlled writes
    if (mutations.complexTaskStates) {
      for (let [key, complexTaskState] of mutations.complexTaskStates) {
        trans.objectStore(TBL_COMPLEX_TASKS).put(complexTaskState, key);
      }
    }

    if (mutations.folders) {
      let store = trans.objectStore(TBL_FOLDER_INFO);
      for (let [folderId, folderInfo] of mutations.folders) {
        let accountId = accountIdFromFolderId(folderId);
        if (folderInfo !== null) {
          store.put(folderInfo, folderId);
        } else {
          store.delete(folderId);
        }
        this.emit(`fldr!${folderId}!change`, folderId, folderInfo);
        this.emit(`acct!${accountId}!folders!tocChange`,
                  folderId, folderInfo, false);
      }
    }

    if (mutations.accounts) {
      // (This intentionally comes after all other mutation types and newData
      // so that our deletions should clobber new introductions of data,
      // although arguably no such writes should be occurring.)
      for (let [accountId, accountDef] of mutations.accounts) {
        if (accountDef) {
          // - Update
          trans.objectStore(TBL_CONFIG)
            .put(accountDef, CONFIG_KEYPREFIX_ACCOUNT_DEF + accountId);
        } else {
          // - Account Deletion!
          this._processAccountDeletion(trans, accountId);
        }

        this.emit(`acct!${accountId}!change`, accountId, accountDef);
        this.emit('accounts!tocChange', accountId, accountDef, false);
      }
    }

    if (mutations.config) {
      trans.objectStore(TBL_CONFIG).put(mutations.config, 'config');
      this.emit('config', mutations.config);
    }

    // -- Tasks
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
      logic(this, 'finishMutate:end', { ctxId: ctx.id });
      this._considerCachePressure('mutate', ctx);
    });
  },
});
// XXX hopefully temporary debugging hack to be able to see when we're properly
// emitting events.
MailDB.prototype._emit = MailDB.prototype.emit;
MailDB.prototype.emit = function(eventName) {
  var listeners = this._events[eventName];
  var listenerCount = listeners ? listeners.length : 0;
  logic(this, 'emit', { name: eventName, listenerCount });
  this._emit.apply(this, arguments);
};
MailDB.prototype._on = MailDB.prototype.on;
MailDB.prototype.on = function(eventName) {
  if (!eventName) {
    throw new Error('no event type provided!');
  }
  logic(this, 'on', { name: eventName });
  this._on.apply(this, arguments);
};
MailDB.prototype._removeListener = MailDB.prototype.removeListener;
MailDB.prototype.removeListener = function(eventName) {
  if (!eventName) {
    throw new Error('no event type provided!');
  }
  logic(this, 'removeListener', { name: eventName });
  this._removeListener.apply(this, arguments);
};

export default MailDB;

define(function(require) {
'use strict';

const co = require('co');
const evt = require('evt');
const logic = require('./logic');

const { accountIdFromConvId, convIdFromMessageId,
        encodedGmailMessageIdFromMessageId } = require('./id_conversions');

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
const TBL_CONV_IDS_BY_FOLDER = 'convIdsByFolder';

/**
 * Message headers.
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
 *
 * Managed by: MailDB
 */
const TBL_HEADERS = 'headers';

/**
 * Message bodies
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
    this.headerCache.clear();
    this.bodyCache.clear();
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
   *
   * @param ctx
   * @param {Object} requests
   *   A dictionary object of Maps whose keys are record identifiers and values
   *   are initially null but will be filled in by us (if we can find the
   *   record).  See the specific
   * @param {Map<ConversationId, ConversationInfo>} requests.conversations
   *   Load the given ConversationInfo structure.
   * @param {Map<ConversationId, HeaderInfo[]>} requests.headersByConversation
   *   Load all of the known headers for the given conversation, returning an
   *   array ordered by the database storage order which is ascending by DateMS
   *   and the encoded gmail message id.  Note that this mechanism currently
   *   cannot take advantage of the `headerCache`.  (There are some easy-ish
   *   things we could do to accomplish this, but it's not believed to be a
   *   major concern at this time.)
   * @param {Map<[MessageId, DateMS], HeaderInfo} requests.headers
   *   Load specific headers.  Note that we need the canonical MessageId plus
   *   the DateMS associated with the header to find the record if it's not in
   *   cache.  This is a little weird but it's assumed you have previously
   *   loaded the (now potentially stale) HeaderInfo and so have the information
   *   at hand.
   * @param {Map<[MessageId, DateMS], BodyInfo} requests.bodies
   *   Load specific bodies using the same idiom as `requests.headers` which
   *   you should read.  Note that there is no "bodiesByConversation" matching
   *   `requests.headersByConversation` because you should not want to do that
   *   as a responsible user of memory.
   */
  read: function(ctx, requests) {
    return new Promise((resolve, reject) => {
      let trans = this._db.transaction(TASK_MUTATION_STORES, 'readonly');

      let dbReqCount = 0;

      if (requests.syncStates) {
        let syncStore = trans.objectStore(TBL_SYNC_STATES);
        let syncStatesRequestsMap = requests.syncStates;
        for (let unlatchedKey of syncStatesRequestsMap.keys()) {
          let key = unlatchedKey;
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
        for (let unlatchedConvId of convRequestsMap.keys()) {
          let convId = unlatchedConvId;
          // fill from cache if available
          if (this.convCache.has(convId)) {
            convRequestsMap.set(convId, this.convCache.get(convId));
            continue;
          }

          // otherwise we need to ask the database
          dbReqCount++;
          let req = convStore.get(convId);
          let handler = (event) => {
            if (req.error) {
              analyzeAndLogErrorEvent(event);
            } else {
              let value = req.result;
              this.convCache.set(convId, value);
              convRequestsMap.set(convId, value);
            }
          };
          req.onsuccess = handler;
          req.onerror = handler;
        }
      }
      if (requests.headersByConversation) {
        let headerStore = trans.objectStore(TBL_HEADERS);
        let headerCache = this.headerCache;
        let requestsMap = requests.headersByConversation;

        for (let unlatchedConvId of requestsMap.keys()) {
          let convId = unlatchedConvId;
          let headerRange = IDBKeyRange.bound([convId],
                                              [convId, []],
                                              true, true);
          dbReqCount++;
          let req = headerStore.mozGetAll(headerRange);
          let handler = (event) => {
            if (req.error) {
              analyzeAndLogErrorEvent(event);
            } else {
              let headers = req.result;
              for (let header of headers) {
                // Put it in the cache unless it's already there (reads must
                // not clobber writes/mutations!)
                // NB: This does mean that there's potential inconsistency
                // problems for this reader in the event the cache does know the
                // header and the values are not the same.
                // TODO: lock that down with checks or some fancy thinkin'
                if (!headerCache.has(header.id)) {
                  headerCache.set(header.id, header);
                }
              }
              requestsMap.set(convId, headers);
            }
          };
          req.onsuccess = handler;
          req.onerror = handler;
        }

      }
      if (requests.headers) {
        let headerStore = trans.objectStore(TBL_HEADERS);
        let headerCache = this.headerCache;
        let headerRequestsMap = requests.headers;
        for (let [unlatchedMessageId, date] of headerRequestsMap.keys()) {
          let messageId = unlatchedMessageId;
          // fill from cache if available
          if (headerCache.has(messageId)) {
            headerRequestsMap.set(messageId, headerCache.get(messageId));
            continue;
          }

          // otherwise we need to ask the database
          let key = [
            convIdFromMessageId(messageId),
            date,
            encodedGmailMessageIdFromMessageId(messageId)
          ];
          dbReqCount++;
          let req = headerStore.get(key);
          let handler = (event) => {
            if (req.error) {
              analyzeAndLogErrorEvent(event);
            } else {
              let header = req.result;
              // Put it in the cache unless it's already there (reads must
              // not clobber writes/mutations!)
              if (!headerCache.has(messageId)) {
                headerCache.set(messageId, header);
              }
              headerRequestsMap.set(messageId, header);
            }
          };
          req.onsuccess = handler;
          req.onerror = handler;
        }
      }
      if (requests.bodies) {
        let bodyStore = trans.objectStore(TBL_BODIES);
        let bodyCache = this.bodyCache;
        let bodyRequestsMap = requests.bodies;
        for (let [unlatchedMessageId, date] of bodyRequestsMap.keys()) {
          let messageId = unlatchedMessageId;
          // fill from cache if available
          if (bodyCache.has(messageId)) {
            bodyRequestsMap.set(messageId, bodyCache.get(messageId));
            continue;
          }

          // otherwise we need to ask the database
          dbReqCount++;
          let key = [
            convIdFromMessageId(messageId),
            date,
            encodedGmailMessageIdFromMessageId(messageId)
          ];
          let req = bodyStore.get(key);
          let handler = (event) => {
            if (req.error) {
              analyzeAndLogErrorEvent(event);
            } else {
              let value = req.result;
              // Put it in the cache unless it's already there (reads must
              // not clobber writes/mutations!)
              if (!bodyCache.has(messageId)) {
                bodyCache.set(messageId, value);
              }
              bodyRequestsMap.set(messageId, value);
            }
          };
          req.onsuccess = handler;
          req.onerror = handler;
        }
      }

      if (!dbReqCount) {
        throw new Error('IndexeDB does *NOT* like empty transactions');
        //resolve(requests);
        // it would be nice if we could have avoided creating the transaction...
      } else {
        trans.oncomplete = () => {
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

      // - headers
      // we need the date for all headers, whether directly loaded or loaded via
      // headersByConversation
      if (mutateRequests.headersByConversation ||
          mutateRequests.headers) {
        let preHeaders = preMutateStates.headers = new Map();

        if (mutateRequests.headersByConversation) {
          for (let convHeaders of
               mutateRequests.headersByConversation.values()) {
            for (let header of convHeaders) {
              preHeaders.set(header.id, header.date);
            }
          }
        }
        if (mutateRequests.headers) {
          for (let header of mutateRequests.headers.values()) {
            preHeaders.set(header.id, header.date);
          }
        }
      }

      // - bodies
      // same deal as headers; we need the date
      if (mutateRequests.bodies) {
        let preBodies = preMutateStates.bodies = new Map();
        for (let body of mutateRequests.bodies.values()) {
          preBodies.set(body.id, body.date);
        }
      }

      return mutateRequests;
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
    logic(this, 'loadFolderConversationIdsAndListen',
          { convCount: tuples.length, eventId: retval.eventId });

    retval.idsWithDates = tuples.map(function(x) {
      return { date: x[1], id: x[2]};
    });
    return retval;
  }),

  _processConvAdditions: function(trans, convs) {
    let convStore = trans.objectStore(TBL_CONV_INFO);
    let convIdsStore = trans.objectStore(TBL_CONV_IDS_BY_FOLDER);
    for (let convInfo of valueIterator(convs)) {
      convStore.add(convInfo, convInfo.id);
      this.convCache.set(convInfo.id, convInfo);

      for (let folderId of convInfo.folderIds) {
        this.emit(eventForFolderId(folderId),
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

      // -- Deletion
      if (convInfo === null) {
        // - Delete the conversation summary
        convStore.delete(convId);
        // - Delete all affiliated headers/bodies
        let headerRange = IDBKeyRange.bound([convId],
                                            [convId, []],
                                            true, true);

        trans.objectStore(TBL_HEADERS).delete(headerRange);
        // bodies currently use the same key representation.
        let bodyRange = IDBKeyRange.bound([convId],
                                          [convId, []],
                                          true, true);
        trans.objectStore(TBL_BODIES).delete(bodyRange);
      } else { // Modification
        convStore.put(convInfo, convId);
        this.convCache.set(convInfo.id, convInfo);
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

  loadConversationMessageIdsAndListen: co.wrap(function*(convId) {
    let eventId = 'conv!' + convId + '!messages!tocChange';
    let retval = this._bufferChangeEventsIdiom(eventId);

    let trans = this._db.transaction(TBL_HEADERS, 'readonly');
    let headerStore = trans.objectStore(TBL_HEADERS);
    let headerRange = IDBKeyRange.bound([convId], [convId, []],
                                        true, true);
    let headers = yield wrapReq(headerStore.mozGetAll(headerRange));

    let headerCache = this.headerCache;
    retval.idsWithDates = headers.map(function(header) {
      // Put it in the cache unless it's already there (reads must
      // not clobber writes/mutations!)
      if (!headerCache.has(header.id)) {
        headerCache.set(header.id, header);
      }
      return { date: header.date, id: header.id};
    });
    return retval;
  }),



  _processHeaderAdditions: function(trans, headers) {
    let store = trans.objectStore(TBL_HEADERS);
    for (let header of valueIterator(headers)) {
      let convId = convIdFromMessageId(header.id);
      let key = [
        convId,
        header.date,
        encodedGmailMessageIdFromMessageId(header.id)
      ];
      store.add(header, key);

      let eventId = 'conv!' + convId + '!messages!tocChange';
      this.emit(eventId, header.id, header);
    }
  },

  /**
   * Process header modification and removal.
   */
  _processHeaderMutations: function(trans, preStates, headers) {
    let store = trans.objectStore(TBL_HEADERS);
    for (let [messageId, header] of headers) {
      let convId = convIdFromMessageId(messageId);
      let date = preStates.get(messageId);
      let key = [
        convId,
        date,
        encodedGmailMessageIdFromMessageId(messageId)
      ];

      if (header === null) {
        // -- Deletion
        store.delete(key);
      } else {
        // -- Modification
        store.put(header, key);
      }

      let eventId = 'conv!' + convId + '!messages!tocChange';
      this.emit(eventId, messageId, date, header);
    }
  },


  _processBodyAdditions: function(trans, bodies) {
    let store = trans.objectStore(TBL_BODIES);
    for (let body of valueIterator(bodies)) {
      let key = [
        convIdFromMessageId(body.id),
        body.date,
        encodedGmailMessageIdFromMessageId(body.id)
      ];
      store.add(body, key);
      // body addition does not generate an event since you technically can't
      // know about them until after they're added.
    }
  },

  _processBodyMutations: function(trans, preStates, bodies) {
    let store = trans.objectStore(TBL_HEADERS);
    for (let [messageId, body] of bodies) {
      let convId = convIdFromMessageId(messageId);
      let date = preStates.get(messageId);
      let key = [
        convId,
        date,
        encodedGmailMessageIdFromMessageId(messageId)
      ];

      if (body === null) {
        // -- Deletion
        store.delete(key);
      } else {
        // -- Modification
        store.put(body, key);
      }

      let eventId = 'body!' + body.id + '!change';
      this.emit(eventId, body);
    }
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

    // -- New / Added data
    let newData = data.newData;
    if (newData) {
      if (newData.conversations) {
        this._processConvAdditions(trans, newData.conversations);
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

    // -- Mutations (begun via beginMutate)
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
            // We handle the syncStates, folders, conversations, headers, and
            // bodies ranges here.
            // Task fallout needs to be explicitly managed by the task in
            // coordination with the TaskManager.
            trans.objectStore(TBL_CONFIG)
              .delete(CONFIG_KEYPREFIX_ACCOUNT_DEF + accountId);

            // Sync state: just delete by accountId.
            trans.objectStore(TBL_SYNC_STATES).delete(accountId);
            // FUTURE: also do a range for per-folder stuff.

            // Folders: Just delete by accountId
            trans.objectStore(TBL_FOLDER_INFO).delete(accountId);

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
            let accountArrayItemPrefix = IDBKeyRange.bound(
              [accountId + '.'],
              [accountId + '.\ufff0'],
              true, true);

            // Conversation: string ordering unicode tricks
            trans.objectStore(TBL_CONV_INFO).delete(accountStringPrefix);
            trans.objectStore(TBL_CONV_IDS_BY_FOLDER).delete(
              accountArrayItemPrefix);

            // Headers: string ordering unicode tricks
            trans.objectStore(TBL_HEADERS).delete(accountArrayItemPrefix);

            // Bodies: string ordering unicode tricks
            trans.objectStore(TBL_BODIES).delete(accountArrayItemPrefix);
          }

          this.emit('accounts!tocChange', accountId, null);
        }
      }
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
      logic(this, 'finishMutate:end');
    });
  },
});
// XXX hopefully temporary debugging hack to be able to see when we're properly
// emitting events.
MailDB.prototype._emit = MailDB.prototype.emit;
MailDB.prototype.emit = function(eventName) {
  logic(this, 'emit', { name: eventName });
  this._emit.apply(this, arguments);
};

return MailDB;
});

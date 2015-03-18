define(function(require, exports, module) {

let log = require('rdcommon/log');
let $a64 = require('../a64');
let $acctmixins = require('../accountmixins');
let $mailslice = require('../mailslice');
let $searchfitler = require('../searchfilter');
let $util = require('../util');
let $folder_info = require('../db/folder_info_rep');

let bsearchForInsert = $util.bsearchForInsert;

function cmpFolderPubPath(a, b) {
  return a.path.localeCompare(b.path);
}

/**
 * A base class for IMAP and POP accounts.
 *
 * A lot of the functionality related to handling folders,
 * orchestrating jobs, etc., is common to both IMAP and POP accounts.
 * This class factors out the common functionality, allowing the
 * ImapAccount and Pop3Account classes to only provide
 * protocol-specific code.
 *
 * @param {Class} FolderSyncer The class to instantiate for folder sync.
 *
 * The rest of the parameters match those passed to Pop3Account and
 * ImapAccount.
 */
function CompositeIncomingAccount(
      FolderSyncer,
      universe, compositeAccount, accountId, credentials,
      connInfo, folderInfos, dbConn, _parentLog, existingProtoConn) {

  this.universe = universe;
  this.compositeAccount = compositeAccount;
  this.id = accountId;
  this.accountDef = compositeAccount.accountDef;
  this.enabled = true;
  this._alive = true;
  this._credentials = credentials;
  this._connInfo = connInfo;
  this._db = dbConn;

  /**
   * @type {Map<FolderId, FolderSyncDB>}
   */
  this.folderSyncDbById = new Map();
  /**
   * @type {Array<FolderInfo>}
   */
  this.folders = [];

  /**
   * The canonical folderInfo object we persist to the database.
   */
  this._folderInfos = folderInfos;
  /**
   * @dict[
   *   @param[nextFolderNum Number]{
   *     The next numeric folder number to be allocated.
   *   }
   *   @param[nextMutationNum Number]{
   *     The next mutation id to be allocated.
   *   }
   *   @param[lastFolderSyncAt DateMS]{
   *     When was the last time we ran `syncFolderList`?
   *   }
   *   @param[capability @listof[String]]{
   *     The post-login capabilities from the server.
   *   }
   *   @param[overflowMap @dictof[
   *     @key[uidl String]
   *     @value[@dict[
   *       @key[size Number]
   *     ]]
   *   ]]{
   *     The list of messages that will NOT be downloaded by a sync
   *     automatically, but instead need to be fetched with a "Download
   *     more messages..." operation. (POP3 only.)
   *   }
   *   @param[uidlMap @dictof[
   *     @key[uidl String]
   *     @value[headerID String]
   *   ]]{
   *     A mapping of UIDLs to message header IDs. (POP3 only.)
   *   }
   * ]{
   *   Meta-information about the account derived from probing the account.
   *   This information gets flushed on database upgrades.
   * }
   */
  this.meta = this._folderInfos.$meta;

  for (let folderId in folderInfos) {
    // ignore the $meta structure and now-moot $-prefixed hacks
    if (folderId[0] === '$')
      continue;
    var folderInfo = folderInfos[folderId];

    this.folderSyncDbById.set(folderId, new FolderSyncDB(this._db, folderId));
    this.folders.push(folderInfo.$meta);
  }
  this.folders.sort(function(a, b) {
    return a.path.localeCompare(b.path);
  });

  // Ensure we have an inbox.  This is a folder that must exist with a standard
  // name, so we can create it without talking to the server.
  var inboxFolder = this.getFirstFolderWithType('inbox');
  if (!inboxFolder) {
    this._learnAboutFolder('INBOX', 'INBOX', null, 'inbox', '/', 0, true);
  }
}
exports.CompositeIncomingAccount = CompositeIncomingAccount;
CompositeIncomingAccount.prototype = {
  ////////////////////////////////////////////////////////////////
  // ACCOUNT OVERRIDES
  runOp: $acctmixins.runOp,
  getFirstFolderWithType: $acctmixins.getFirstFolderWithType,
  getFolderByPath: $acctmixins.getFolderByPath,
  saveAccountState: $acctmixins.saveAccountState,
  runAfterSaves: $acctmixins.runAfterSaves,

  /**
   * Make a given folder known to us, creating state tracking instances, etc.
   *
   * @param {Boolean} suppressNotification
   *   Don't report this folder to subscribed slices.  This is used in cases
   *   where the account has not been made visible to the front-end yet and/or
   *   syncFolderList hasn't yet run, but something subscribed to the "all
   *   accounts" unified folder slice could end up seeing something before it
   *   should.  This is a ret-con'ed comment, so maybe do some auditing before
   *   adding new call-sites that use this, especially if it's not used for
   *   offline-only folders at account creation/app startup.
   */
  _learnAboutFolder: function(name, path, parentId, type, delim, depth,
                              suppressNotification) {
    var folderId = this.id + '.' + $a64.encodeInt(this.meta.nextFolderNum++);
    var folderInfo = this._folderInfos[folderId] = {
      $meta: $folder_info.makeFolderMeta({
        id: folderId,
        name: name,
        type: type,
        path: path,
        parentId: parentId,
        delim: delim,
        depth: depth,
        lastSyncedAt: 0,
        version: $mailslice.FOLDER_DB_VERSION
      }),
      serverIdHeaderBlockMapping: null, // IMAP/POP3 does not need the mapping
    };
    this.folderSyncDbById.set(folderId, new FolderSyncDB(this._db, folderId));

    var folderMeta = folderInfo.$meta;
    var idx = bsearchForInsert(this.folders, folderMeta, cmpFolderPubPath);
    this.folders.splice(idx, 0, folderMeta);

    if (!suppressNotification)
      this.universe.__notifyAddedFolder(this, folderMeta);
    return folderMeta;
  },

  _forgetFolder: function(folderId, suppressNotification) {
    var folderInfo = this._folderInfos[folderId],
        folderMeta = folderInfo.$meta;
    delete this._folderInfos[folderId];

    // XXX TODO this needs to be a task that cleans up the database state and
    // was added as part of the completion of the syncFolderList task.
    let folderSyncDb = this.folderSyncDbById.get(folderId);
    if (folderSyncDb) {
      folderSyncDb.youAreDeadCleanupAfterYourself();
    }
    this.folderSyncDbById.delete(folderId);

    var idx = this.folders.indexOf(folderMeta);
    this.folders.splice(idx, 1);

    if (!suppressNotification)
      this.universe.__notifyRemovedFolder(this, folderMeta);
  },

  /**
   * Completely reset the state of a folder.  For use by unit tests and in the
   * case of UID validity rolls.  No notification is generated, although slices
   * are repopulated.
   *
   * FYI: There is a nearly identical method in ActiveSync's account
   * implementation.
   */
  _recreateFolder: function(folderId, callback) {
    this._LOG.recreateFolder(folderId);
    var folderInfo = this._folderInfos[folderId];
    folderInfo.$impl = {
      nextId: 0,
      nextHeaderBlock: 0,
      nextBodyBlock: 0,
    };
    folderInfo.accuracy = [];
    folderInfo.headerBlocks = [];
    folderInfo.bodyBlocks = [];

    if (this._deadFolderIds === null)
      this._deadFolderIds = [];
    this._deadFolderIds.push(folderId);

    var self = this;
    this.saveAccountState(null, function() {
      var newStorage =
        new $mailslice.FolderStorage(self, folderId, folderInfo, self._db,
                                     self.FolderSyncer,
                                     self._LOG);
      for (var iter in Iterator(self._folderStorages[folderId]._slices)) {
        var slice = iter[1];
        slice._storage = newStorage;
        slice.reset();
        newStorage.sliceOpenMostRecent(slice);
      }
      self._folderStorages[folderId]._slices = [];
      self._folderStorages[folderId] = newStorage;

      callback(newStorage);
    }, 'recreateFolder');
  },

  /**
   * We are being told that a synchronization pass completed, and that we may
   * want to consider persisting our state.
   */
  __checkpointSyncCompleted: function(callback, betterReason) {
    this.saveAccountState(null, callback, betterReason || 'checkpointSync');
  },

  /**
   * Delete an existing folder WITHOUT ANY ABILITY TO UNDO IT. Current
   * UX does not desire this, but the unit tests do.
   *
   * XXX: This is not quite right for POP3; address when we expose
   * deleting folders to the UI when we need to create jobs too.
   *
   * Callback is like the createFolder one, why not.
   */
  deleteFolder: function(folderId, callback) {
    if (!this._folderInfos.hasOwnProperty(folderId))
      throw new Error("No such folder: " + folderId);

    if (!this.universe.online) {
      if (callback)
        callback('offline');
      return;
    }

    var folderMeta = this._folderInfos[folderId].$meta;

    var rawConn = null, self = this;
    function gotConn(conn) {
      rawConn = conn;
      rawConn.delBox(folderMeta.path, deletionCallback);
    }
    function deletionCallback(err) {
      if (err)
        done('unknown');
      else
        done(null);
    }
    function done(errString) {
      if (rawConn) {
        self.__folderDoneWithConnection(rawConn, false, false);
        rawConn = null;
      }
      if (!errString) {
        self._LOG.deleteFolder(folderMeta.path);
        self._forgetFolder(folderId);
      }
      if (callback)
        callback(errString, folderMeta);
    }
    this.__folderDemandsConnection(null, 'deleteFolder', gotConn);
  },

  getFolderMetaForFolderId: function(folderId) {
    if (this._folderInfos.hasOwnProperty(folderId))
      return this._folderInfos[folderId].$meta;
    return null;
  },

  sliceFolderMessages: function(folderId, bridgeHandle) {
    var storage = this._folderStorages[folderId],
        slice = new $mailslice.MailSlice(bridgeHandle, storage, this._LOG);

    storage.sliceOpenMostRecent(slice);
  },

  searchFolderMessages: function(folderId, bridgeHandle, phrase, whatToSearch) {
    var storage = this._folderStorages[folderId],
        slice = new $searchfilter.SearchSlice(bridgeHandle, storage, phrase,
                                              whatToSearch, this._LOG);
    storage.sliceOpenSearch(slice);
    return slice;
  },

  shutdownFolders: function() {
    // - kill all folder storages (for their loggers)
    for (var iFolder = 0; iFolder < this.folders.length; iFolder++) {
      var folderPub = this.folders[iFolder],
          folderStorage = this._folderStorages[folderPub.id];
      folderStorage.shutdown();
    }
  },

  scheduleMessagePurge: function(folderId, callback) {
    this.universe.purgeExcessMessages(this.compositeAccount, folderId,
                                      callback);
  },

  /**
   * We receive this notification from our _backoffEndpoint.
   */
  onEndpointStateChange: function(state) {
    switch (state) {
      case 'healthy':
        this.universe.__removeAccountProblem(this.compositeAccount,
                                             'connection', 'incoming');
        break;
      case 'unreachable':
      case 'broken':
        this.universe.__reportAccountProblem(this.compositeAccount,
                                             'connection', 'incoming');
        break;
    }
  },
};

exports.LOGFAB_DEFINITION = {
  CompositeIncomingAccount: {
    type: log.ACCOUNT,
    events: {
      createFolder: {},
      deleteFolder: {},
      recreateFolder: { id: false },

      createConnection: {},
      reuseConnection: {},
      releaseConnection: {},
      deadConnection: { why: true },
      unknownDeadConnection: {},
      connectionMismatch: {},

      /**
       * XXX: this is really an error/warning, but to make the logging less
       * confusing, treat it as an event.
       */
      accountDeleted: { where: false },

      /**
       * The maximum connection limit has been reached, we are intentionally
       * not creating an additional one.
       */
      maximumConnsNoNew: {},
    },
    TEST_ONLY_events: {
      deleteFolder: { path: false },

      createConnection: { label: false },
      reuseConnection: { label: false },
      releaseConnection: { folderId: false, label: false },
      deadConnection: { folder: false },
      connectionMismatch: {},
    },
    errors: {
      connectionError: {},
      folderAlreadyHasConn: { folderId: false },
      opError: { mode: false, type: false, ex: log.EXCEPTION },
    },
    asyncJobs: {
      checkAccount: { err: null },
      runOp: { mode: true, type: true, error: true, op: false },
      saveAccountState: { reason: true, folderSaveCount: true },
    },
    TEST_ONLY_asyncJobs: {
    },
  },
};

}); // end define

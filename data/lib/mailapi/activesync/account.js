/**
 * Implements the ActiveSync protocol for Hotmail and Exchange.
 **/

define(
  [
    'rdcommon/log',
    'mailcomposer',
    'wbxml',
    'activesync/codepages',
    'activesync/protocol',
    '../a64',
    '../mailslice',
    './folder',
    './jobs',
    '../util',
    'module',
    'exports'
  ],
  function(
    $log,
    $mailcomposer,
    $wbxml,
    $ascp,
    $activesync,
    $a64,
    $mailslice,
    $asfolder,
    $asjobs,
    $util,
    $module,
    exports
  ) {
'use strict';

const bsearchForInsert = $util.bsearchForInsert;

function ActiveSyncAccount(universe, accountDef, folderInfos, dbConn,
                           receiveProtoConn, _parentLog) {
  this.universe = universe;
  this.id = accountDef.id;
  this.accountDef = accountDef;

  this.conn = new $activesync.Connection(accountDef.credentials.username,
                                         accountDef.credentials.password);
  this._db = dbConn;

  this._LOG = LOGFAB.ActiveSyncAccount(this, _parentLog, this.id);

  this._jobDriver = new $asjobs.ActiveSyncJobDriver(this);

  this.enabled = true;
  this.problems = [];

  this.identities = accountDef.identities;

  this.folders = [];
  this._folderStorages = {};
  this._folderInfos = folderInfos;
  this._serverIdToFolderId = {};
  this._deadFolderIds = null;

  this._syncsInProgress = 0;
  this._lastSyncKey = null;
  this._lastSyncResponseWasEmpty = false;

  this.meta = folderInfos.$meta;
  this.mutations = folderInfos.$mutations;

  // Sync existing folders
  for (var folderId in folderInfos) {
    if (folderId[0] === '$')
      continue;
    var folderInfo = folderInfos[folderId];

    this._folderStorages[folderId] =
      new $mailslice.FolderStorage(this, folderId, folderInfo, this._db,
                                   $asfolder.ActiveSyncFolderConn, this._LOG);
    this._serverIdToFolderId[folderInfo.$meta.serverId] = folderId;
    this.folders.push(folderInfo.$meta);
  }
  // TODO: we should probably be smarter about sorting.
  this.folders.sort(function(a, b) { return a.path.localeCompare(b.path); });

  if (this.accountDef.connInfo)
    this.conn.setConfig(this.accountDef.connInfo);
  this.conn.connect();

  // TODO: this is a really hacky way of syncing folders after the first time.
  if (this.meta.syncKey != '0')
    setTimeout(this.syncFolderList.bind(this), 1000);
}
exports.ActiveSyncAccount = ActiveSyncAccount;
ActiveSyncAccount.prototype = {
  toString: function asa_toString() {
    return '[ActiveSyncAccount: ' + this.id + ']';
  },

  toBridgeWire: function asa_toBridgeWire() {
    return {
      id: this.accountDef.id,
      name: this.accountDef.name,
      path: this.accountDef.name,
      type: this.accountDef.type,

      enabled: this.enabled,
      problems: this.problems,

      identities: this.identities,

      credentials: {
        username: this.accountDef.credentials.username,
      },

      servers: [
        {
          type: this.accountDef.type,
          connInfo: this.accountDef.connInfo
        },
      ]
    };
  },

  toBridgeFolder: function asa_toBridgeFolder() {
    return {
      id: this.accountDef.id,
      name: this.accountDef.name,
      path: this.accountDef.name,
      type: 'account',
    };
  },

  get numActiveConns() {
    return 0;
  },

  saveAccountState: function asa_saveAccountState(reuseTrans, callback) {
    let perFolderStuff = [];
    for (let [,folder] in Iterator(this.folders)) {
      let folderStuff = this._folderStorages[folder.id]
                           .generatePersistenceInfo();
      if (folderStuff)
        perFolderStuff.push(folderStuff);
    }

    let trans = this._db.saveAccountFolderStates(
      this.id, this._folderInfos, perFolderStuff, this._deadFolderIds,
      function stateSaved() {
        if (callback)
         callback();
      }, reuseTrans);
    this._deadFolderIds = null;
    return trans;
  },

  /**
   * We are being told that a synchronization pass completed, and that we may
   * want to consider persisting our state.
   */
  __checkpointSyncCompleted: function() {
    this.saveAccountState();
  },

  shutdown: function asa_shutdown() {
  },

  createFolder: function asa_createFolder() {
    throw new Error('XXX not implemented');
  },

  deleteFolder: function asa_deleteFolder() {
    throw new Error('XXX not implemented');
  },

  sliceFolderMessages: function asa_sliceFolderMessages(folderId,
                                                        bridgeHandle) {
    let storage = this._folderStorages[folderId],
        slice = new $mailslice.MailSlice(bridgeHandle, storage, this._LOG);

    storage.sliceOpenFromNow(slice);
  },

  syncFolderList: function asa_syncFolderList(callback) {
    let account = this;

    const fh = $ascp.FolderHierarchy.Tags;
    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(fh.FolderSync)
       .tag(fh.SyncKey, account.meta.syncKey)
     .etag();

    this.conn.doCommand(w, function(aError, aResponse) {
      let e = new $wbxml.EventParser();
      let deferredAddedFolders = [];

      e.addEventListener([fh.FolderSync, fh.SyncKey], function(node) {
        account.meta.syncKey = node.children[0].textContent;
      });

      e.addEventListener([fh.FolderSync, fh.Changes, [fh.Add, fh.Delete]],
                         function(node) {
        let folder = {};
        for (let [,child] in Iterator(node.children))
          folder[child.localTagName] = child.children[0].textContent;

        if (node.tag === fh.Add) {
          if (!account._addedFolder(folder.ServerId, folder.ParentId,
                                    folder.DisplayName, folder.Type))
            deferredAddedFolders.push(folder);
        }
        else {
          account._deletedFolder(folder.ServerId);
        }
      });

      e.run(aResponse);

      // It's possible we got some folders in an inconvenient order (i.e. child
      // folders before their parents). Keep trying to add folders until we're
      // done.
      while (deferredAddedFolders.length) {
        let moreDeferredAddedFolders = [];
        for (let [,folder] in Iterator(deferredAddedFolders)) {
          if (!account._addedFolder(folder.ServerId, folder.ParentId,
                                    folder.DisplayName, folder.Type))
            moreDeferredAddedFolders.push(folder);
        }
        if (moreDeferredAddedFolders.length === deferredAddedFolders.length)
          throw new Error('got some orphaned folders');
        deferredAddedFolders = moreDeferredAddedFolders;
      }

      account.saveAccountState();
      if (callback)
        callback();
    });
  },

  // Map folder type numbers from ActiveSync to Gaia's types
  _folderTypes: {
     1: 'normal', // User-created generic folder
     2: 'inbox',
     3: 'drafts',
     4: 'trash',
     5: 'sent',
     6: 'normal', // Outbox, actually
    12: 'normal', // User-created mail folder
  },

  /**
   * Update the internal database and notify the appropriate listeners when we
   * discover a new folder.
   *
   * @param {string} serverId A GUID representing the new folder
   * @param {string} parentId A GUID representing the parent folder, or '0' if
   *   this is a root-level folder
   * @param {string} displayName The display name for the new folder
   * @param {string} typeNum A numeric value representing the new folder's type,
   *   corresponding to the mapping in _folderTypes above
   * @return {boolean} true if we added the folder, false if we need to wait
   *   until later (e.g. if we haven't added the folder's parent yet)
   */
  _addedFolder: function asa__addedFolder(serverId, parentId, displayName,
                                          typeNum) {
    if (!(typeNum in this._folderTypes))
      return true; // Not a folder type we care about.

    let path = displayName;
    let depth = 0;
    if (parentId !== '0') {
      let parentFolderId = this._serverIdToFolderId[parentId];
      if (parentFolderId === undefined)
        return false;
      let parent = this._folderInfos[parentFolderId];
      path = parent.$meta.path + '/' + path;
      depth = parent.$meta.depth + 1;
    }

    let folderId = this.id + '/' + $a64.encodeInt(this.meta.nextFolderNum++);
    let folderInfo = this._folderInfos[folderId] = {
      $meta: {
        id: folderId,
        serverId: serverId,
        name: displayName,
        path: path,
        type: this._folderTypes[typeNum],
        depth: depth,
        syncKey: '0',
      },
      $impl: {
        nextHeaderBlock: 0,
        nextBodyBlock: 0,
      },
      accuracy: [],
      headerBlocks: [],
      bodyBlocks: [],
    };

    this._folderStorages[folderId] =
      new $mailslice.FolderStorage(this, folderId, folderInfo, this._db,
                                   $asfolder.ActiveSyncFolderConn, this._LOG);
    this._serverIdToFolderId[serverId] = folderId;

    var account = this;
    var idx = bsearchForInsert(this.folders, folderInfo.$meta, function(a, b) {
      return a.path.localeCompare(b.path);
    });
    this.folders.splice(idx, 0, folderInfo.$meta);

    this.universe.__notifyAddedFolder(this.id, folderInfo.$meta);

    return true;
  },

  /**
   * Update the internal database and notify the appropriate listeners when we
   * find out a folder has been removed.
   *
   * @param {string} serverId A GUID representing the deleted folder
   */
  _deletedFolder: function asa__deletedFolder(serverId) {
    let folderId = this._serverIdToFolderId[serverId],
        folderInfo = this._folderInfos[folderId],
        folderMeta = folderInfo.$meta;
    delete this._serverIdToFolderId[serverId];
    delete this._folderInfos[folderId];
    delete this._folderStorages[folderId];

    var idx = this.folders.indexOf(folderMeta);
    this.folders.splice(idx, 1);

    if (this._deadFolderIds === null)
      this._deadFolderIds = [];
    this._deadFolderIds.push(folderId);

    this.universe.__notifyRemovedFolder(this.id, folderMeta);
  },

  _recreateFolder: function asa__recreateFolder(folderId, callback) {
    let folderInfo = this._folderInfos[folderId];
    folderInfo.accuracy = [];
    folderInfo.headerBlocks = [];
    folderInfo.bodyBlocks = [];

    if (this._deadFolderIds === null)
      this._deadFolderIds = [];
    this._deadFolderIds.push(folderId);

    let self = this;
    this.saveAccountState(null, function() {
      let newStorage =
        new $mailslice.FolderStorage(self, folderId, folderInfo, self._db,
                                     $asfolder.ActiveSyncFolderConn, self._LOG);
      for (let [,slice] in Iterator(self._folderStorages[folderId]._slices)) {
        slice._storage = newStorage;
        slice._resetHeadersBecauseOfRefreshExplosion(true);
        newStorage.sliceOpenFromNow(slice);
      }
      self._folderStorages[folderId]._slices = [];
      self._folderStorages[folderId] = newStorage;

      callback(newStorage);
    });
  },

  sendMessage: function asa_sendMessage(composedMessage, callback) {
    // XXX: This is very hacky and gross. Fix it to use pipes later.
    composedMessage._cacheOutput = true;
    composedMessage._composeMessage();

    const cm = $ascp.ComposeMail.Tags;
    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(cm.SendMail)
       .tag(cm.ClientId, Date.now().toString()+'@mozgaia')
       .tag(cm.SaveInSentItems)
       .stag(cm.Mime)
         .opaque(composedMessage._outputBuffer)
       .etag()
     .etag();

    this.conn.doCommand(w, function(aError, aResponse) {
      if (aResponse === null)
        callback(null);
      else {
        dump('Error sending message. XML dump follows:\n' + aResponse.dump() +
             '\n');
      }
    });
  },

  getFolderStorageForFolderId: function asa_getFolderStorageForFolderId(
                               folderId) {
    return this._folderStorages[folderId];
  },

  getFolderStorageForServerId: function asa_getFolderStorageForServerId(
                               serverId) {
    return this._folderStorages[this._serverIdToFolderId[serverId]];
  },

  runOp: function asa_runOp(op, mode, callback) {
    dump('runOp('+JSON.stringify(op)+', '+mode+', '+callback+')\n');

    let methodName = mode + '_' + op.type;
    let isLocal = /^local_/.test(mode);

    if (!isLocal)
      op.status = mode + 'ing';

    if (!(methodName in this._jobDriver))
      throw new Error("Unsupported op: '" + op.type + "' (mode: " + mode + ")");

    if (callback) {
      this._jobDriver[methodName](op, function(error) {
        if (!isLocal)
          op.status = mode + 'ne';
        callback(error);
      });
    }
    else {
      this._jobDriver[methodName](op);
      if (!isLocal)
        op.status = mode + 'ne';
    }
  },
};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  ActiveSyncAccount: {
    type: $log.ACCOUNT,
    events: {
      createFolder: {},
      deleteFolder: {},
    },
    asyncJobs: {
      runOp: { mode: true, type: true, error: false, op: false },
      saveAccountState: {},
    },
  },
});

}); // end define

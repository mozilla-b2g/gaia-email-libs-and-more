/**
 * Implements the ActiveSync protocol for Hotmail and Exchange.
 **/

define(
  [
    'mailcomposer',
    'wbxml',
    'activesync/codepages',
    'activesync/protocol',
    './util',
    'exports'
  ],
  function(
    $mailcomposer,
    $wbxml,
    $ascp,
    $activesync,
    $imaputil,
    exports
  ) {
const bsearchForInsert = $imaputil.bsearchForInsert;

function ActiveSyncAccount(universe, accountDef, folderInfos, dbConn,
                           receiveProtoConn, _LOG) {
  this.universe = universe;
  this.id = accountDef.id;
  this.accountDef = accountDef;

  this._db = dbConn;

  this.enabled = true;
  this.problems = [];

  this.identities = accountDef.identities;

  var ourIdentity = accountDef.identities[0];
  var ourNameAndAddress = {
    name: ourIdentity.name,
    address: ourIdentity.address,
  };

  this.folders = [];
  this._folderStorages = {};
  this._folderInfos = folderInfos;
  this._deadFolderIds = null;

  this.meta = folderInfos.$meta;
  this.mutations = folderInfos.$mutations;

  // Sync existing folders
  for (var folderId in folderInfos) {
    if (folderId[0] === '$')
      continue;
    var folderInfo = folderInfos[folderId];

    this._folderStorages[folderId] =
      new ActiveSyncFolderStorage();
    this.folders.push(folderInfo.$meta);
  }
  // TODO: we should probably be smarter about sorting.
  this.folders.sort(function(a, b) a.path.localeCompare(b.path));

  if (this.meta.syncKey != "0") {
    // TODO: this is a really hacky way of syncing folders later
    var account = this;
    setTimeout(function() { account.syncFolderList(function() {}) }, 1000);
  }
}
exports.ActiveSyncAccount = ActiveSyncAccount;
ActiveSyncAccount.prototype = {
  toString: function fa_toString() {
    return '[ActiveSyncAccount: ' + this.id + ']';
  },
  toBridgeWire: function fa_toBridgeWire() {
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
  toBridgeFolder: function() {
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

  saveAccountState: function(reuseTrans) {
    var trans = this._db.saveAccountFolderStates(
      this.id, this._folderInfos, [], this._deadFolderIds,
      function stateSaved() {
      },
      reuseTrans);
    this._deadFolderIds = null;
    return trans;
  },

  shutdown: function() {
  },

  createFolder: function() {
    throw new Error('XXX not implemented');
  },

  deleteFolder: function() {
    throw new Error('XXX not implemented');
  },

  sliceFolderMessages: function fa_sliceFolderMessages(folderId, bridgeHandle) {
    return this._folderStorages[folderId]._sliceFolderMessages(bridgeHandle);
  },

  syncFolderList: function fa_syncFolderList(callback) {
    var account = this;
    var conn = new $activesync.Connection(
      this.accountDef.credentials.username,
      this.accountDef.credentials.password,
      function(aResult) {
        var fh = $ascp.FolderHierarchy.Tags;
        var w = new $wbxml.Writer("1.3", 1, "UTF-8");
        w.stag(fh.FolderSync)
           .tag(fh.SyncKey, account.meta.syncKey)
         .etag();

        var folder;
        var depth = 0;
        this.doCommand(w, function(aResponse) {
          for (var node in aResponse.document) {
            if (node.type == "STAG" && node.tag == fh.SyncKey) {
              var text = aResponse.document.next();
              if (text.type != "TEXT")
                throw new Error("expected TEXT node");
              if (aResponse.document.next().type != "ETAG")
                throw new Error("expected ETAG node");

              account.meta.syncKey = text.textContent;
            }
            else if (node.type == "STAG" &&
                     (node.tag == fh.Add || node.tag == fh.Delete)) {
              depth = 1;
              folder = { add: node.tag == fh.Add };
            }
            else if (depth) {
              if (node.type == "ETAG") {
                if (--depth == 0) {
                  if (folder.add)
                    account._addedFolder(folder.ServerId, folder.DisplayName,
                                         folder.Type);
                  else
                    account._deletedFolder(folder.ServerId);
                }
              }
              else if (node.type == "STAG") {
                var text = aResponse.document.next();
                if (text.type != "TEXT")
                  throw new Error("expected TEXT node");
                if (aResponse.document.next().type != "ETAG")
                  throw new Error("expected ETAG node");

                folder[node.localTagName] = text.textContent;
              }
              else {
                throw new Error("unexpected node!");
              }
            }
          }

          account.saveAccountState();
          callback();
        });
    });
  },

  _addedFolder: function as__addFolder(serverId, displayName, typeNum) {
    const types = {
       1: "normal", // User-created generic folder
       2: "inbox",
       3: "drafts",
       4: "trash",
       5: "sent",
       6: "normal", // Outbox, actually
      12: "normal", // User-created mail folder
    };

    if (!(typeNum in types))
      return; // Not a folder type we care about.

    var folderId = this.id + '/' + serverId;
    var folderInfo = {
      $meta: {
        id: folderId,
        name: displayName,
        path: displayName,
        type: types[typeNum],
        delim: "/",
        depth: 0,
      },
      $impl: {
        nextHeaderBlock: 0,
        nextBodyBlock: 0,
      },
      accuracy: [],
      headerBlocks: [],
      bodyBlocks: [],
    };

    this._folderInfos[folderId] = folderInfo;
    this._folderStorages[folderId] = new ActiveSyncFolderStorage();

    var account = this;
    var idx = bsearchForInsert(this.folders, folderInfo.$meta, function(a, b) {
      return a.path.localeCompare(b.path);
    });
    this.folders.splice(idx, 0, folderInfo.$meta);

    this.universe.__notifyAddedFolder(this.id, folderInfo.$meta);
  },

  _deletedFolder: function as__removeFolder(serverId) {
    var folderId = this.id + '/' + serverId;
    var folderInfo = this._folderInfos[folderId],
        folderMeta = folderInfo.$meta;
    delete this._folderInfos[folderId];
    delete this._folderStorages[folderId];

    var idx = this.folders.indexOf(folderMeta);
    this.folders.splice(idx, 1);

    if (this._deadFolderIds === null)
      this._deadFolderIds = [];
    this._deadFolderIds.push(folderId);

    this.universe.__notifyRemovedFolder(this.id, folderMeta);
  },

  sendMessage: function fa_sendMessage(composedMessage, callback) {
    // XXX put a copy of the message in the sent folder
    callback(null);
  },

  getFolderStorageForFolderId: function fa_getFolderStorageForFolderId(folderId){
    return this._folderStorages[folderId];
  },

  runOp: function(op, mode, callback) {
    // Just pretend we performed the op so no errors trigger.
    if (callback)
      setZeroTimeout(callback);
  },
};

function ActiveSyncFolderStorage() {
  this._headers = [];
  this._bodiesBySuid = {};
}
ActiveSyncFolderStorage.prototype = {
  _sliceFolderMessages: function ffs__sliceFolderMessages(bridgeHandle) {
    bridgeHandle.sendSplice(0, 0, this._headers, true, false);
  },

  getMessageBody: function ffs_getMessageBody(suid, date, callback) {
    callback(this._bodiesBySuid[suid]);
  },
};

}); // end define

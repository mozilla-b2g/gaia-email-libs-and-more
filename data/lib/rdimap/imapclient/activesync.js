/**
 * Implements the ActiveSync protocol for Hotmail and Exchange.
 **/

define(
  [
    'mailcomposer',
    'wbxml',
    'activesync/codepages',
    'activesync/protocol',
    './asfolder',
    './util',
    'exports'
  ],
  function(
    $mailcomposer,
    $wbxml,
    $ascp,
    $activesync,
    $asfolder,
    $imaputil,
    exports
  ) {
const bsearchForInsert = $imaputil.bsearchForInsert;

function ActiveSyncAccount(universe, accountDef, folderInfos, dbConn,
                           receiveProtoConn, _LOG) {
  this.universe = universe;
  this.id = accountDef.id;
  this.accountDef = accountDef;

  this.conn = new $activesync.Connection(accountDef.credentials.username,
                                         accountDef.credentials.password);
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
      new $asfolder.ActiveSyncFolderStorage(this, folderId.split('/')[1]);
    this.folders.push(folderInfo.$meta);
  }
  // TODO: we should probably be smarter about sorting.
  this.folders.sort(function(a, b) { return a.path.localeCompare(b.path); });

  if (this.meta.syncKey != "0") {
    // TODO: this is a really hacky way of syncing folders after the first
    // time.
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

    var fh = $ascp.FolderHierarchy.Tags;
    var w = new $wbxml.Writer("1.3", 1, "UTF-8");
    w.stag(fh.FolderSync)
       .tag(fh.SyncKey, account.meta.syncKey)
     .etag();

    this.conn.doCommand(w, function(aResponse) {
      var e = new $wbxml.EventParser();

      e.addEventListener([fh.FolderSync, fh.SyncKey], function(node) {
        account.meta.syncKey = node.children[0].textContent;
      });

      e.addEventListener([fh.FolderSync, fh.Changes, [fh.Add, fh.Remove]],
                         function(node) {
        var folder = {};
        for (var i = 0; i < node.children.length; i++) {
          folder[node.children[i].localTagName] =
            node.children[i].children[0].textContent;
        }

        if (node.tag == fh.Add)
          account._addedFolder(folder.ServerId, folder.DisplayName,
                               folder.Type);
        else
          account._deletedFolder(folder.ServerId);
      });

      e.run(aResponse);

      account.saveAccountState();
      callback();
    });
  },

  // Map folder type numbers from ActiveSync to Gaia's types
  _folderTypes: {
     1: "normal", // User-created generic folder
     2: "inbox",
     3: "drafts",
     4: "trash",
     5: "sent",
     6: "normal", // Outbox, actually
    12: "normal", // User-created mail folder
  },

  _addedFolder: function as__addFolder(serverId, displayName, typeNum) {
    if (!(typeNum in this._folderTypes))
      return; // Not a folder type we care about.

    var folderId = this.id + '/' + serverId;
    var folderInfo = {
      $meta: {
        id: folderId,
        name: displayName,
        path: displayName,
        type: this._folderTypes[typeNum],
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
    this._folderStorages[folderId] = new $asfolder.ActiveSyncFolderStorage(
      this, serverId);

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
    // XXX: This is very hacky and gross. Fix it to use pipes later.
    composedMessage._cacheOutput = true;
    composedMessage._composeMessage();

    var cm = $ascp.ComposeMail.Tags;
    var w = new $wbxml.Writer("1.3", 1, "UTF-8");
    w.stag(cm.SendMail)
       .tag(cm.ClientId, Date.now().toString()+"@mozgaia")
       .tag(cm.SaveInSentItems)
       .stag(cm.Mime)
         .opaque(composedMessage._outputBuffer)
       .etag()
     .etag();

    this.conn.doCommand(w, function(aResponse) {
      if (aResponse === null)
        callback(null);
      else {
        dump("Error sending message. XML dump follows:\n" + aResponse.dump() +
             "\n");
      }
    });
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

}); // end define

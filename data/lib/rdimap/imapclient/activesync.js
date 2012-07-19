/**
 * Implements the ActiveSync protocol for Hotmail and Exchange.
 **/

define(
  [
    'mailcomposer',
    'wbxml',
    'activesync/codepages',
    'activesync/protocol',
    'exports'
  ],
  function(
    $mailcomposer,
    $wbxml,
    $ascp,
    $activesync,
    exports
  ) {

function ActiveSyncAccount(universe, accountDef, folderInfo, receiveProtoConn,
                           _LOG) {
  this.universe = universe;
  this.id = accountDef.id;
  this.accountDef = accountDef;

  this.enabled = true;
  this.problems = [];

  this.identities = accountDef.identities;

  var ourIdentity = accountDef.identities[0];
  var ourNameAndAddress = {
    name: ourIdentity.name,
    address: ourIdentity.address,
  };

  var account = this;
  var conn = new $activesync.Connection(
    accountDef.credentials.username, accountDef.credentials.password,
    function(aResult) {
      var fh = $ascp.FolderHierarchy.Tags;
      var w = new $wbxml.Writer("1.3", 1, "UTF-8");
      w.stag(fh.FolderSync)
         .tag(fh.SyncKey, "0")
       .etag();

      this.doCommand(w, function(aResponse) {
        for (var node in aResponse.document) {
          if (node.type == "STAG" && node.tag == fh.DisplayName) {
            var text = aResponse.document.next();
            if (text.type != "TEXT")
              throw new Error("expected TEXT node");

            var folder = {
              id: account.id + '/' + text.textContent,
              name: text.textContent,
              path: text.textContent,
              type: 'normal',
              delim: '/',
              depth: 0,
            };
            account.folders.push(folder);
            account._folderStorages[folder.id] = new ActiveSyncFolderStorage();
            account.universe.__notifyAddedFolder(account.id, folder);

            if (aResponse.document.next().type != "ETAG")
              throw new Error("expected ETAG node");
          }
        }
      });
    });

  // Pretend we have an inbox for now. We'll get the real inbox later.
  var inboxFolder = {
    id: this.id + '/0',
    name: 'Inbox',
    path: 'Inbox',
    type: 'inbox',
    delim: '/',
    depth: 0,
  };
  this.folders = [inboxFolder];
  this._folderStorages = {};
  this._folderStorages[inboxFolder.id] = new ActiveSyncFolderStorage();

  this.meta = folderInfo.$meta;
  this.mutations = folderInfo.$mutations;
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
    return reuseTrans;
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
    // NOP; our list of folders is eternal (for now)
    callback();
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

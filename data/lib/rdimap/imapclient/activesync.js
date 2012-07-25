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
      new ActiveSyncFolderStorage();
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

      // XXX: remove this (it loads messages for the inbox)
      account._loadMessages('00000000-0000-0000-0000-000000000001');
    });
  },

  _loadMessages: function(serverId) {
    var account = this;
    var as = ActiveSyncCodepages.AirSync.Tags;
    var em = ActiveSyncCodepages.Email.Tags;

    var w = new WBXML.Writer("1.3", 1, "UTF-8");
    w.stag(as.Sync)
       .stag(as.Collections)
         .stag(as.Collection)
           .tag(as.SyncKey, "0")
           .tag(as.CollectionId, serverId)
         .etag()
       .etag()
     .etag();

    this.conn.doCommand(w, function(aResponse) {
      var syncKey;
      var e = new $wbxml.EventParser();
      e.addEventListener([as.Sync, as.Collections, as.Collection, as.SyncKey],
                         function(node) {
        syncKey = node.children[0].textContent;
      });
      e.run(aResponse);

      var w = new WBXML.Writer("1.3", 1, "UTF-8");
      w.stag(as.Sync)
         .stag(as.Collections)
           .stag(as.Collection)
             .tag(as.SyncKey, syncKey)
             .tag(as.CollectionId, serverId)
             .tag(as.GetChanges)
           .etag()
         .etag()
       .etag();

      var folderId = account.id + '/' + serverId;
      var folderStorage = account._folderStorages[folderId];
      account.conn.doCommand(w, function(aResponse) {
        var e = new $wbxml.EventParser();
        e.addEventListener([as.Sync, as.Collections, as.Collection, as.Commands,
                            as.Add, as.ApplicationData],
        function(node) {
          var guid = Date.now() + Math.random().toString(16).substr(1) +
            '@mozgaia';
          var headers = {
            subject: null,
            author: null,
            date: null,
            flags: [],
            id: null,
            suid: folderId + '/' + guid,
            guid: guid,
            hasAttachments: false,
            snippet: null,
          };
          var body = {
            to: null,
            cc: null,
            bcc: null,
            replyTo: null,
            attachments: null,
            references: null,
            bodyRep: [0x1, "This is my message body. There are many like it, " +
                      "but this one is mine."],
          };

          for (var i = 0; i < node.children.length; i++) {
            var child = node.children[i];
            var childText = child.children.length &&
                            child.children[0].textContent;

            if (child.tag == em.Subject)
              headers.subject = childText;
            else if (child.tag == em.From || child.tag == em.To) {
              // XXX: This address parser is probably very bad. Fix it.
              var m = childText.match(/"(.+?)" <(.+)>/);
              var addr = m ? { name: m[1], address: m[2] } :
                             { name: "", address: childText };
              if (child.tag == em.From)
                headers.author = addr;
              else // XXX: I wonder how this works with multiple To: fields???
                body.to = [addr];
            }
            else if (child.tag == em.DateReceived)
              headers.date = new Date(childText).valueOf();
            else if (child.tag == em.Read) {
              if (childText == "1")
                headers.flags.push('\\Seen');
            }
          }

          folderStorage._headers.push(headers);
          folderStorage._bodiesBySuid[headers.suid] = body;
        });
        e.run(aResponse);
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
      dump(aResponse.dump()+"\n\n");
      callback(null);
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

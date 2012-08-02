define(
  [
    'wbxml',
    'activesync/codepages',
    'activesync/protocol',
    'mimelib',
    './quotechew',
    'exports'
  ],
  function(
    $wbxml,
    $ascp,
    $activesync,
    $mimelib,
    $quotechew,
    exports
  ) {
'use strict';

function ActiveSyncFolderStorage(account, folderInfo, dbConn) {
  this.account = account;
  this._db = dbConn;

  this.folderId = folderInfo.$meta.id;
  this.serverId = folderInfo.$meta.serverId;
  this.folderMeta = folderInfo.$meta;
  if (!this.folderMeta.syncKey)
    this.folderMeta.syncKey = '0';

  this._headers = [];
  this._bodiesBySuid = {};

  this._onLoadListeners = [];

  let loading = 0;
  function onLoaded(type, block) {
    if (++loading == 2) {
      this._loaded = true;
      for (let [,listener] in Iterator(this._onLoadListeners))
        listener();
      this._onLoadListeners = [];
    }
    if (!block)
      return;

    if (type === 'header')
      this._headers = block;
    else
      this._bodiesBySuid = block;
  }

  this._db.loadHeaderBlock(this.folderId, 0, onLoaded.bind(this, 'header'));
  this._db.loadBodyBlock(this.folderId, 0, onLoaded.bind(this, 'body'));
}
exports.ActiveSyncFolderStorage = ActiveSyncFolderStorage;
ActiveSyncFolderStorage.prototype = {
  generatePersistenceInfo: function() {
    return {
      id: this.folderId,
      headerBlocks: [ this._headers ],
      bodyBlocks:   [ this._bodiesBySuid ],
    };
  },

  _getSyncKey: function(callback) {
    let folderStorage = this;
    let account = this.account;
    let as = $ascp.AirSync.Tags;

    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(as.Sync)
       .stag(as.Collections)
         .stag(as.Collection)

    if (account.conn.currentVersionInt < $activesync.VersionInt('12.1'))
          w.tag(as.Class, 'Email');

          w.tag(as.SyncKey, '0')
           .tag(as.CollectionId, this.serverId)
         .etag()
       .etag()
     .etag();

    account.conn.doCommand(w, function(aError, aResponse) {
      if (aError)
        return;

      let e = new $wbxml.EventParser();
      e.addEventListener([as.Sync, as.Collections, as.Collection, as.SyncKey],
                         function(node) {
        folderStorage.folderMeta.syncKey = node.children[0].textContent;
      });
      e.run(aResponse);

      callback();
    });
  },

  _loadMessages: function(callback, deferred) {
    let folderStorage = this;
    let account = this.account;

    if (!account.conn.connected) {
      account.conn.autodiscover(function(config) {
        // TODO: handle errors
        folderStorage._loadMessages(callback, deferred);
      });
      return;
    }
    if (this.folderMeta.syncKey === '0' && !deferred) {
      this._getSyncKey(this._loadMessages.bind(this, callback, true));
      return;
    }

    let as = $ascp.AirSync.Tags;
    let asb = $ascp.AirSyncBase.Tags;

    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(as.Sync)
       .stag(as.Collections)
         .stag(as.Collection);

    if (account.conn.currentVersionInt < $activesync.VersionInt('12.1'))
          w.tag(as.Class, 'Email');

          w.tag(as.SyncKey, this.folderMeta.syncKey)
           .tag(as.CollectionId, this.serverId)
           .tag(as.GetChanges)
           .stag(as.Options)

    if (account.conn.currentVersionInt >= $activesync.VersionInt('12.0'))
            w.stag(asb.BodyPreference)
               .tag(asb.Type, '1')
             .etag();

            w.tag(as.MIMESupport, '2')
             .tag(as.MIMETruncation, '7')
           .etag()
         .etag()
       .etag()
     .etag();

    account.conn.doCommand(w, function(aError, aResponse) {
      if (aError)
        return;
      if (!aResponse) {
        callback([], {});
        return;
      }

      let e = new $wbxml.EventParser();
      let headers = [];
      let bodies = {};
      let status;

      const base = [as.Sync, as.Collections, as.Collection];
      e.addEventListener(base.concat(as.Status), function(node) {
        status = node.children[0].textContent;
      });

      e.addEventListener(base.concat(as.SyncKey), function(node) {
        folderStorage.folderMeta.syncKey = node.children[0].textContent;
      });

      e.addEventListener(base.concat(as.Commands, as.Add), function(node) {
        let guid;
        let msg;

        for (let [,child] in Iterator(node.children)) {
          switch (child.tag) {
          case as.ServerId:
            guid = child.children[0].textContent;
            break;
          case as.ApplicationData:
            msg = folderStorage._processAddedMessage(child);
            break;
          }
        }

        msg.headers.guid = guid;
        msg.headers.suid = folderStorage.folderId + '/' + guid;
        headers.push(msg.headers);
        bodies[msg.headers.suid] = msg.body;
      });

      e.run(aResponse);

      if (status === '1') { // Success
        headers.sort(function(a, b) a.date < b.date);
        callback(headers, bodies);
      }
      else if (status === '3') { // Bad sync key
        console.log('ActiveSync had a bad sync key');
        // This should already be set to 0, but let's just be safe.
        folderStorage.folderMeta.syncKey = '0';
        folderStorage._needsPurge = true;
        folderStorage._loadMessages(callback);
      }
      else {
        console.error('Something went wrong during ActiveSync syncing and we ' +
                      'got a status of ' + status);
      }
    });
  },

  _processAddedMessage: function(node) {
    let asb = $ascp.AirSyncBase.Tags;
    let em = $ascp.Email.Tags;

    let headers = {
      subject: null,
      author: null,
      date: null,
      flags: [],
      id: null,
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
      bodyRep: null,
    };

    for (let [,child] in Iterator(node.children)) {
      let childText = child.children.length &&
                      child.children[0].textContent;

      switch (child.tag) {
      case em.Subject:
        headers.subject = childText;
        break;
      case em.From:
        headers.author = $mimelib.parseAddresses(childText)[0];
        break;
      case em.To:
        body.to = $mimelib.parseAddresses(childText);
        break;
      case em.Cc:
        body.cc = $mimelib.parseAddresses(childText);
        break;
      case em.ReplyTo:
        body.replyTo = $mimelib.parseAddresses(childText);
        break;
      case em.DateReceived:
        headers.date = new Date(childText).valueOf();
        break;
      case em.Read:
        if (childText == '1')
          headers.flags.push('\\Seen');
        break;
      case em.Flag:
        for (let [,grandchild] in Iterator(child.children)) {
          if (grandchild.tag === em.Status &&
              grandchild.children[0].textContent !== '0')
            headers.flags.push('\\Flagged');
        }
        break;
      case asb.Body: // ActiveSync 12.0+
        for (let [,grandchild] in Iterator(child.children)) {
          if (grandchild.tag === asb.Data) {
            body.bodyRep = $quotechew.quoteProcessTextBody(
              grandchild.children[0].textContent);
            headers.snippet = $quotechew.generateSnippet(body.bodyRep);
          }
        }
        break;
      case em.Body: // pre-ActiveSync 12.0
        body.bodyRep = $quotechew.quoteProcessTextBody(childText);
        headers.snippet = $quotechew.generateSnippet(body.bodyRep);
        break;
      case asb.Attachments: // ActiveSync 12.0+
      case em.Attachments:  // pre-ActiveSync 12.0
        headers.hasAttachments = true;
        body.attachments = [];
        for (let [,attachmentNode] in Iterator(child.children)) {
          if (attachmentNode.tag !== asb.Attachment &&
              attachmentNode.tag !== em.Attachment)
            continue; // XXX: throw an error here??

          let attachment = { type: 'text/plain' }; // XXX: this is lies
          for (let [,attachData] in Iterator(attachmentNode.children)) {
            switch (attachData.tag) {
            case asb.DisplayName:
            case em.DisplayName:
              attachment.name = attachData.children[0].textContent;
              break;
            case asb.EstimatedDataSize:
            case em.AttSize:
              attachment.sizeEstimate = attachData.children[0].textContent;
              break;
            }
          }
          body.attachments.push(attachment);
        }
        break;
      }
    }

    return { headers: headers, body: body };
  },

  _sliceFolderMessages: function ffs__sliceFolderMessages(bridgeHandle) {
    if (!this._loaded) {
      this._onLoadListeners.push(this._sliceFolderMessages
                                     .bind(this, bridgeHandle));
      return;
    }

    bridgeHandle.sendSplice(0, 0, this._headers, true, true);

    var folderStorage = this;
    this._loadMessages(function(headers, bodies) {
      if (folderStorage._needsPurge) {
        bridgeHandle.sendSplice(0, folderStorage._headers.length, [], false,
                                true);
        folderStorage._headers = [];
        folderStorage._bodiesBySuid = {};
        folderStorage._needsPurge = false;
      }

      folderStorage._headers = folderStorage._headers.concat(headers);
      folderStorage._headers.sort(function(a, b) a.date < b.date);
      for (let [k,v] in Iterator(bodies))
        folderStorage._bodiesBySuid[k] = v;

      bridgeHandle.sendSplice(0, 0, headers, true, false);
      folderStorage.account.saveAccountState();
    });
  },

  getMessageBody: function ffs_getMessageBody(suid, date, callback) {
    callback(this._bodiesBySuid[suid]);
  },
};

}); // end define

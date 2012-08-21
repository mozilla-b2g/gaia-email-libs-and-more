define(
  [
    'wbxml',
    'activesync/codepages',
    'activesync/protocol',
    'mimelib',
    '../quotechew',
    '../util',
    'exports'
  ],
  function(
    $wbxml,
    $ascp,
    $activesync,
    $mimelib,
    $quotechew,
    $util,
    exports
  ) {
'use strict';

function ActiveSyncFolderConn(account, storage, _parentLog) {
  this._account = account;
  this._storage = storage;
  this.serverId = storage.folderMeta.serverId;

  if (!this.syncKey)
    this.syncKey = '0';
  if (!storage.folderMeta.totalMessages)
    storage.folderMeta.totalMessages = 0;
}
exports.ActiveSyncFolderConn = ActiveSyncFolderConn;
ActiveSyncFolderConn.prototype = {
  get syncKey() {
    return this._storage.folderMeta.syncKey;
  },

  set syncKey(value) {
    return this._storage.folderMeta.syncKey = value;
  },

  get totalMessages() {
    return this._storage.folderMeta.totalMessages;
  },

  /**
   * Get the initial sync key for the folder so we can start getting data
   *
   * @param {function} callback A callback to be run when the operation finishes
   */
  _getSyncKey: function asfs__getSyncKey(callback) {
    let folderConn = this;
    let account = this._account;
    const as = $ascp.AirSync.Tags;

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
        folderConn.syncKey = node.children[0].textContent;
      });
      e.run(aResponse);

      callback();
    });
  },

  /**
   * Sync the folder with the server and enumerate all the changes since the
   * last sync.
   *
   * @param {function} callback A function to be called when the operation has
   *   completed, taking three arguments: |added|, |changed|, and |deleted|
   * @param {boolean} deferred True if this operation was already deferred once
   *   to get the initial sync key
   */
  _enumerateFolderChanges: function asfs__enumerateFolderChanges(callback,
                                                                 deferred) {
    let folderConn = this;
    let account = this._account;

    if (!account.conn.connected) {
      account.conn.autodiscover(function(status, config) {
        // TODO: handle errors
        folderConn._enumerateFolderChanges(callback, deferred);
      });
      return;
    }
    if (this.syncKey === '0' && !deferred) {
      this._getSyncKey(this._enumerateFolderChanges.bind(this, callback, true));
      return;
    }

    const as = $ascp.AirSync.Tags;
    const asEnum = $ascp.AirSync.Enums;
    const asb = $ascp.AirSyncBase.Tags;
    const asbEnum = $ascp.AirSyncBase.Enums;

    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(as.Sync)
       .stag(as.Collections)
         .stag(as.Collection);

    if (account.conn.currentVersionInt < $activesync.VersionInt('12.1'))
          w.tag(as.Class, 'Email');

          w.tag(as.SyncKey, this.syncKey)
           .tag(as.CollectionId, this.serverId)
           .tag(as.GetChanges)
           .stag(as.Options)

    if (account.conn.currentVersionInt >= $activesync.VersionInt('12.0'))
            w.stag(asb.BodyPreference)
               .tag(asb.Type, asbEnum.Type.PlainText)
             .etag();

            w.tag(as.MIMESupport, asEnum.MIMESupport.Never)
             .tag(as.MIMETruncation, asEnum.MIMETruncation.NoTruncate)
           .etag()
         .etag()
       .etag()
     .etag();

    account.conn.doCommand(w, function(aError, aResponse) {
      let added   = { headers: [], bodies: {} };
      let changed = { headers: [], bodies: {} };
      let deleted = [];
      let status;

      if (aError)
        return;
      if (!aResponse) {
        callback(added, changed, deleted);
        return;
      }

      let e = new $wbxml.EventParser();
      const base = [as.Sync, as.Collections, as.Collection];

      e.addEventListener(base.concat(as.Status), function(node) {
        status = node.children[0].textContent;
      });

      e.addEventListener(base.concat(as.SyncKey), function(node) {
        folderConn.syncKey = node.children[0].textContent;
      });

      e.addEventListener(base.concat(as.Commands, [[as.Add, as.Change]]),
                         function(node) {
        let guid;
        let msg;

        for (let [,child] in Iterator(node.children)) {
          switch (child.tag) {
          case as.ServerId:
            guid = child.children[0].textContent;
            break;
          case as.ApplicationData:
            msg = folderConn._parseMessage(child, node.tag === as.Add);
            break;
          }
        }

        msg.header.guid = guid;
        msg.header.suid = folderConn._storage.folderId + '/' + guid;

        let collection = node.tag === as.Add ? added : changed;
        collection.headers.push(msg.header);
        collection.bodies[msg.header.suid] = msg.body;
      });

      e.addEventListener(base.concat(as.Commands, as.Delete), function(node) {
        let guid;

        for (let [,child] in Iterator(node.children)) {
          switch (child.tag) {
          case as.ServerId:
            guid = child.children[0].textContent;
            break;
          }
        }

        deleted.push(guid);
      });

      e.run(aResponse);

      if (status === asEnum.Status.Success) {
        callback(added, changed, deleted);
      }
      else if (status === asEnum.Status.InvalidSyncKey) {
        console.log('ActiveSync had a bad sync key');
        // This should already be set to 0, but let's just be safe.
        throw new Error('not supported yet');
        folderConn.syncKey = '0';
        folderConn._needsPurge = true;
        folderConn._enumerateFolderChanges(callback);
      }
      else {
        console.error('Something went wrong during ActiveSync syncing and we ' +
                      'got a status of ' + status);
      }
    });
  },

  /**
   * Parse the DOM of an individual message to build header and body objects for
   * it.
   *
   * @param {WBXML.Element} node The fully-parsed node describing the message
   * @param {boolean} isAdded True if this is a new message, false if it's a
   *   changed one
   * @return {object} An object containing the header and body for the message
   */
  _parseMessage: function asfs__parseMessage(node, isAdded) {
    const asb = $ascp.AirSyncBase.Tags;
    const em = $ascp.Email.Tags;
    let header, body, flagHeader;

    if (isAdded) {
      header = {
        id: null,
        suid: null,
        guid: null,
        author: null,
        date: null,
        flags: [],
        hasAttachments: false,
        subject: null,
        snippet: null,
      };

      body = {
        date: null,
        size: null,
        to: null,
        cc: null,
        bcc: null,
        replyTo: null,
        attachments: [],
        references: null,
        bodyReps: null,
      };

      flagHeader = function(flag, state) {
        if (state)
          header.flags.push(flag);
      }
    }
    else {
      header = {
        flags: [],
        mergeInto: function(o) {
          // Merge flags
          for (let [,flagstate] in Iterator(this.flags)) {
            if (flagstate[1]) {
              o.flags.push(flagstate[0]);
            }
            else {
              let index = o.flags.indexOf(flagstate[0]);
              if (index !== -1)
                o.flags.splice(index, 1);
            }
          }

          // Merge everything else
          for (let [key, value] in Iterator(this)) {
            if (['mergeInto', 'suid', 'guid', 'flags'].indexOf(key) !== -1)
              continue;

            o[key] = value;
          }
        },
      };

      body = {
        mergeInto: function(o) {
          for (let [key, value] in Iterator(this)) {
            if (key === 'mergeInto') continue;
            o[key] = value;
          }
        },
      };

      flagHeader = function(flag, state) {
        header.flags.push([flag, state]);
      }
    }

    for (let [,child] in Iterator(node.children)) {
      let childText = child.children.length &&
                      child.children[0].textContent;

      switch (child.tag) {
      case em.Subject:
        header.subject = childText;
        break;
      case em.From:
        header.author = $mimelib.parseAddresses(childText)[0] || null;
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
        body.date = header.date = new Date(childText).valueOf();
        break;
      case em.Read:
        flagHeader('\\Seen', childText === '1');
        break;
      case em.Flag:
        for (let [,grandchild] in Iterator(child.children)) {
          if (grandchild.tag === em.Status)
            flagHeader('\\Flagged', grandchild.children[0].textContent !== '0');
        }
        break;
      case asb.Body: // ActiveSync 12.0+
        for (let [,grandchild] in Iterator(child.children)) {
          if (grandchild.tag === asb.Data) {
            body.bodyReps = [
              'plain',
              $quotechew.quoteProcessTextBody(
                grandchild.children[0].textContent)
            ];
            header.snippet = $quotechew.generateSnippet(body.bodyReps[1]);
          }
        }
        break;
      case em.Body: // pre-ActiveSync 12.0
        body.bodyReps = [
          'plain',
          $quotechew.quoteProcessTextBody(childText)
        ];
        header.snippet = $quotechew.generateSnippet(body.bodyReps[1]);
        break;
      case asb.Attachments: // ActiveSync 12.0+
      case em.Attachments:  // pre-ActiveSync 12.0
        header.hasAttachments = true;
        body.attachments = [];
        for (let [,attachmentNode] in Iterator(child.children)) {
          if (attachmentNode.tag !== asb.Attachment &&
              attachmentNode.tag !== em.Attachment)
            continue; // XXX: throw an error here??

          let attachment = { name: null, type: null, part: null,
                             sizeEstimate: null };

          for (let [,attachData] in Iterator(attachmentNode.children)) {
            let dot, ext;

            switch (attachData.tag) {
            case asb.DisplayName:
            case em.DisplayName:
              attachment.name = attachData.children[0].textContent;

              // Get the file's extension to look up a mimetype, but ignore it
              // if the filename is of the form '.bashrc'.
              dot = attachment.name.lastIndexOf('.');
              ext = dot > 0 ? attachment.name.substring(dot + 1) : '';
              attachment.type = $mimelib.contentTypes[ext] ||
                                'application/octet-stream';
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

    return { header: header, body: body };
  },

  syncDateRange: function asfc_syncDateRange(startTS, endTS, accuracyStamp,
                                             useBisectLimit, doneCallback) {
    let storage = this._storage;
    let self = this;
    this._enumerateFolderChanges(function(added, changed, deleted) {
      for (let [,header] in Iterator(added.headers)) {
        storage.addMessageHeader(header);
        storage.addMessageBody(header, added.bodies[header.suid]);
      }

      for (let [,header] in Iterator(changed.headers)) {
        // XXX: TODO
      }

      for (let [,header] in Iterator(deleted)) {
        // XXX: TODO
      }

      storage.folderMeta.totalMessages += added.headers.length /*-
        deleted.headers.length*/;

      storage.markSyncRange(startTS, endTS, 'XXX', accuracyStamp);
      doneCallback(null, added.headers.length);
    });
  },
};

}); // end define

define(
  [
    'rdcommon/log',
    'wbxml',
    'activesync/codepages',
    'activesync/protocol',
    'mimelib',
    '../quotechew',
    '../date',
    '../syncbase',
    '../util',
    'module',
    'exports'
  ],
  function(
    $log,
    $wbxml,
    $ascp,
    $activesync,
    $mimelib,
    $quotechew,
    $date,
    $sync,
    $util,
    $module,
    exports
  ) {
'use strict';

const DESIRED_SNIPPET_LENGTH = 100;

const FILTER_TYPE = $ascp.AirSync.Enums.FilterType;

// Map our built-in sync range values to their corresponding ActiveSync
// FilterType values.
const SYNC_RANGE_TO_FILTER_TYPE = {
   '1d': FILTER_TYPE.OneDayBack,
   '3d': FILTER_TYPE.ThreeDaysBack,
   '1w': FILTER_TYPE.OneWeekBack,
   '2w': FILTER_TYPE.TwoWeeksBack,
   '1m': FILTER_TYPE.OneMonthBack,
   '3m': FILTER_TYPE.ThreeMonthsBack,
   '6m': FILTER_TYPE.SixMonthsBack,
  'all': FILTER_TYPE.NoFilter,
};

function ActiveSyncFolderConn(account, storage, _parentLog) {
  this._account = account;
  this._storage = storage;
  this._LOG = LOGFAB.ActiveSyncFolderConn(this, _parentLog, storage.folderId);

  this.folderMeta = storage.folderMeta;
  this.serverId = this.folderMeta.serverId;

  if (!this.syncKey)
    this.syncKey = '0';
}
ActiveSyncFolderConn.prototype = {
  get syncKey() {
    return this.folderMeta.syncKey;
  },

  set syncKey(value) {
    return this.folderMeta.syncKey = value;
  },

  get filterType() {
    let syncRange = this._account.accountDef.syncRange;
    if (SYNC_RANGE_TO_FILTER_TYPE.hasOwnProperty(syncRange)) {
      return SYNC_RANGE_TO_FILTER_TYPE[syncRange];
    }
    else {
      console.warn('Got an invalid syncRange: ' + syncRange +
                   ': using three days back instead');
      return $ascp.AirSync.Enums.FilterType.ThreeDaysBack;
    }
  },

  /**
   * Get the initial sync key for the folder so we can start getting data
   *
   * @param {function} callback A callback to be run when the operation finishes
   */
  _getSyncKey: function asfc__getSyncKey(callback) {
    let folderConn = this;
    let account = this._account;
    const as = $ascp.AirSync.Tags;

    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(as.Sync)
       .stag(as.Collections)
         .stag(as.Collection)

    if (account.conn.currentVersion.lt('12.1'))
          w.tag(as.Class, 'Email');

          w.tag(as.SyncKey, '0')
           .tag(as.CollectionId, this.serverId)
           .stag(as.Options)
             .tag(as.FilterType, this.filterType)
           .etag()
         .etag()
       .etag()
     .etag();

    account.conn.postCommand(w, function(aError, aResponse) {
      if (aError) {
        console.error(aError);
        return;
      }

      let e = new $wbxml.EventParser();
      e.addEventListener([as.Sync, as.Collections, as.Collection, as.SyncKey],
                         function(node) {
        folderConn.syncKey = node.children[0].textContent;
      });
      e.run(aResponse);

      if (folderConn.syncKey === '0')
        console.error('Unable to get sync key for folder');
      else
        callback();
    });
  },

  /**
   * Sync the folder with the server and enumerate all the changes since the
   * last sync.
   *
   * @param {function} callback A function to be called when the operation has
   *   completed, taking three arguments: |added|, |changed|, and |deleted|
   */
  _enumerateFolderChanges: function asfc__enumerateFolderChanges(callback) {
    let folderConn = this, storage = this._storage;
    let account = this._account;

    if (!account.conn.connected) {
      account.conn.connect(function(error, config) {
        if (error)
          console.error('Error connecting to ActiveSync:', error);
        else
          folderConn._enumerateFolderChanges(callback);
      });
      return;
    }
    if (this.syncKey === '0') {
      this._getSyncKey(this._enumerateFolderChanges.bind(this, callback));
      return;
    }

    const as = $ascp.AirSync.Tags;
    const asEnum = $ascp.AirSync.Enums;
    const asb = $ascp.AirSyncBase.Tags;
    const asbEnum = $ascp.AirSyncBase.Enums;

    let w;

    // If the last sync was ours and we got an empty response back, we can send
    // an empty request to repeat our request. This saves a little bandwidth.
    if (this._account._syncsInProgress++ === 0 &&
        this._account._lastSyncKey === this.syncKey &&
        this._account._lastSyncResponseWasEmpty) {
      w = as.Sync;
    }
    else {
      w = new $wbxml.Writer('1.3', 1, 'UTF-8');
      w.stag(as.Sync)
         .stag(as.Collections)
           .stag(as.Collection);

      if (account.conn.currentVersion.lt('12.1'))
            w.tag(as.Class, 'Email');

            w.tag(as.SyncKey, this.syncKey)
             .tag(as.CollectionId, this.serverId)
             .tag(as.GetChanges)
             .stag(as.Options)
               .tag(as.FilterType, this.filterType)

      if (account.conn.currentVersion.gte('12.0'))
              w.stag(asb.BodyPreference)
                 .tag(asb.Type, asbEnum.Type.PlainText)
               .etag();

              w.tag(as.MIMESupport, asEnum.MIMESupport.Never)
               .tag(as.MIMETruncation, asEnum.MIMETruncation.NoTruncate)
             .etag()
           .etag()
         .etag()
       .etag();
    }

    account.conn.postCommand(w, function(aError, aResponse) {
      let added   = [];
      let changed = [];
      let deleted = [];
      let status;
      let moreAvailable = false;

      folderConn._account._syncsInProgress--;

      if (aError) {
        console.error('Error syncing folder:', aError);
        return;
      }

      folderConn._account._lastSyncKey = folderConn.syncKey;

      if (!aResponse) {
        console.log('Sync completed with empty response');
        folderConn._account._lastSyncResponseWasEmpty = true;
        callback(null, added, changed, deleted);
        return;
      }

      folderConn._account._lastSyncResponseWasEmpty = false;
      let e = new $wbxml.EventParser();
      const base = [as.Sync, as.Collections, as.Collection];

      e.addEventListener(base.concat(as.SyncKey), function(node) {
        folderConn.syncKey = node.children[0].textContent;
      });

      e.addEventListener(base.concat(as.Status), function(node) {
        status = node.children[0].textContent;
      });

      e.addEventListener(base.concat(as.MoreAvailable), function(node) {
        moreAvailable = true;
      });

      e.addEventListener(base.concat(as.Commands, [[as.Add, as.Change]]),
                         function(node) {
        let id;
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

        if (node.tag === as.Add) {
          msg.header.id = id = storage._issueNewHeaderId();
          msg.header.suid = folderConn._storage.folderId + '/' + id;
          msg.header.guid = '';
        }
        msg.header.srvid = guid;
        // XXX need to get the message's message-id header value!

        let collection = node.tag === as.Add ? added : changed;
        collection.push(msg);
      });

      e.addEventListener(base.concat(as.Commands, [as.Delete, as.SoftDelete]),
                         function(node) {
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
        console.log('Sync completed: added ' + added.length + ', changed ' +
                    changed.length + ', deleted ' + deleted.length);
        callback(null, added, changed, deleted, moreAvailable);
        if (moreAvailable)
          folderConn._enumerateFolderChanges(callback);
      }
      else if (status === asEnum.Status.InvalidSyncKey) {
        console.warn('ActiveSync had a bad sync key');
        callback('badkey');
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
  _parseMessage: function asfc__parseMessage(node, isAdded) {
    const asb = $ascp.AirSyncBase.Tags;
    const em = $ascp.Email.Tags;
    let header, body, flagHeader;

    if (isAdded) {
      header = {
        id: null,
        srvid: null,
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
          const skip = ['mergeInto', 'suid', 'srvid', 'guid', 'id', 'flags'];
          for (let [key, value] in Iterator(this)) {
            if (skip.indexOf(key) !== -1)
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
            header.snippet = $quotechew.generateSnippet(body.bodyReps[1],
                                                        DESIRED_SNIPPET_LENGTH);
          }
        }
        break;
      case em.Body: // pre-ActiveSync 12.0
        body.bodyReps = [
          'plain',
          $quotechew.quoteProcessTextBody(childText)
        ];
        header.snippet = $quotechew.generateSnippet(body.bodyReps[1],
                                                    DESIRED_SNIPPET_LENGTH);
        break;
      case asb.Attachments: // ActiveSync 12.0+
      case em.Attachments:  // pre-ActiveSync 12.0
        header.hasAttachments = true;
        body.attachments = [];
        for (let [,attachmentNode] in Iterator(child.children)) {
          if (attachmentNode.tag !== asb.Attachment &&
              attachmentNode.tag !== em.Attachment)
            continue;

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
                                             doneCallback) {
    let storage = this._storage;
    let folderConn = this;
    let messagesSeen = 0;

    this._LOG.syncDateRange_begin(null, null, null, startTS, endTS);
    this._enumerateFolderChanges(function (error, added, changed, deleted,
                                           moreAvailable) {
      if (error === 'badkey') {
        folderConn._account._recreateFolder(storage.folderId, function(s) {
          folderConn.storage = s;
        });
        return;
      }

      for (let [,message] in Iterator(added)) {
        storage.addMessageHeader(message.header);
        storage.addMessageBody(message.header, message.body);
      }

      for (let [,message] in Iterator(changed)) {
        storage.updateMessageHeaderByServerId(message.header.srvid, true,
                                              function(oldHeader) {
          message.header.mergeInto(oldHeader);
          return true;
        });
        // XXX: update bodies
      }

      for (let [,messageGuid] in Iterator(deleted)) {
        storage.deleteMessageByServerId(messageGuid);
      }

      messagesSeen += added.length + changed.length + deleted.length;

      if (!moreAvailable) {
        folderConn._LOG.syncDateRange_end(null, null, null, startTS, endTS);
        storage.markSyncRange(startTS, endTS, 'XXX', accuracyStamp);
        doneCallback(null, messagesSeen);
      }
    });
  },

  prepareMutation: function() {
    const as = $ascp.AirSync.Tags;

    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(as.Sync)
       .stag(as.Collections);

    w.stag(as.Collection);

    if (this._account.conn.currentVersion.lt('12.1'))
      w.tag(as.Class, 'Email');

      w.tag(as.SyncKey, this._storage.folderMeta.syncKey)
       .tag(as.CollectionId, this._storage.folderMeta.serverId)
       .stag(as.Commands);

    return w;
  },

  performMutations: function(w, callback) {
    const as = $ascp.AirSync.Tags,
          folderConn = this;

    w.etag(as.Commands)
     .etag(as.Collection);

    this.account.conn.postCommand(w, function(aError, aResponse) {
      if (aError)
        callback('unknown');

      let e = new $wbxml.EventParser();
      let syncKey, status;

      const base = [as.Sync, as.Collections, as.Collection];
      e.addEventListener(base.concat(as.SyncKey), function(node) {
        syncKey = node.children[0].textContent;
      });
      e.addEventListener(base.concat(as.Status), function(node) {
        status = node.children[0].textContent;
      });

      e.run(aResponse);

      if (status === '1') {
        folderConn.syncKey = syncKey;
        if (callback)
          callback(null);
      }
      else {
        console.error('Something went wrong during ActiveSync syncing and we ' +
                      'got a status of ' + status);
        callback('status:' + status);
      }
    });
  },
};

function ActiveSyncFolderSyncer(account, folderStorage, _parentLog) {
  this._account = account;
  this.folderStorage = folderStorage;

  this._LOG = LOGFAB.ActiveSyncFolderSyncer(this, _parentLog,
                                            folderStorage.folderId);

  this.folderConn = new ActiveSyncFolderConn(account, folderStorage, this._LOG);
}
exports.ActiveSyncFolderSyncer = ActiveSyncFolderSyncer;
ActiveSyncFolderSyncer.prototype = {
  syncDateRange: function(startTS, endTS, syncCallback) {
    syncCallback('sync', false, true);
    this.folderConn.syncDateRange(startTS, endTS, $date.NOW(),
                                  this.onSyncCompleted.bind(this));
  },

  syncAdjustedDateRange: function(startTS, endTS, syncCallback) {
    // ActiveSync doesn't adjust date ranges. Just do a normal sync.
    this.syncDateRange(startTS, endTS, syncCallback);
  },

  refreshSync: function(startTS, endTS, useBisectLimit, callback) {
    this.folderConn.syncDateRange(startTS, endTS, $date.NOW(), callback);
  },

  // Returns false if no sync is necessary.
  growSync: function(endTS, batchHeaders, userRequestsGrowth, syncCallback) {
    // ActiveSync is different, and trying to sync more doesn't work with it.
    // Just assume we've got all we need.
    return false;
  },

  /**
   * Whatever synchronization we last triggered has now completed; we should
   * either trigger another sync if we still want more data, or close out the
   * current sync.
   */
  onSyncCompleted: function ifs_onSyncCompleted(bisectInfo, messagesSeen) {
    let storage = this.folderStorage;

    console.log("Sync Completed!", messagesSeen, "messages synced");

    // Expand the accuracy range to cover everybody.
    storage.markSyncedEntireFolder();

    storage._curSyncSlice.ignoreHeaders = false;
    storage._curSyncSlice.waitingOnData = 'db';

    storage.getMessagesInImapDateRange(
      0, $date.FUTURE(), $sync.INITIAL_FILL_SIZE, $sync.INITIAL_FILL_SIZE,
      // Don't trigger a refresh; we just synced.
      storage.onFetchDBHeaders.bind(storage, storage._curSyncSlice, false)
    );

    storage._curSyncSlice = null;
    this._account.__checkpointSyncCompleted();
  },

  allConsumersDead: function() {
  },

  shutdown: function() {
    this.folderConn.shutdown();
    this._LOG.__die();
  },
};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  ActiveSyncFolderConn: {
    type: $log.CONNECTION,
    subtype: $log.CLIENT,
    events: {
    },
    asyncJobs: {
      syncDateRange: {
        newMessages: true, existingMessages: true, deletedMessages: true,
        start: false, end: false,
      },
    },
  },
  ActiveSyncFolderSyncer: {
    type: $log.DATABASE,
    events: {
    }
  },
});

}); // end define

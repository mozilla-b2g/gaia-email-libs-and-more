define(
  [
    'rdcommon/log',
    'wbxml',
    'activesync/codepages',
    'activesync/protocol',
    'mimelib',
    '../quotechew',
    '../htmlchew',
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
    $htmlchew,
    $date,
    $sync,
    $util,
    $module,
    exports
  ) {
'use strict';

var DESIRED_SNIPPET_LENGTH = 100;

/**
 * This is minimum number of messages we'd like to get for a folder for a given
 * sync range. It's not exact, since we estimate from the number of messages in
 * the past two weeks, but it's close enough.
 */
var DESIRED_MESSAGE_COUNT = 50;

var FILTER_TYPE = $ascp.AirSync.Enums.FilterType;

/**
 * Map our built-in sync range values to their corresponding ActiveSync
 * FilterType values. We exclude 3 and 6 months, since they aren't valid for
 * email.
 *
 * Also see SYNC_RANGE_ENUMS_TO_MS in `syncbase.js`.
 */
var SYNC_RANGE_TO_FILTER_TYPE = {
  'auto': null,
    '1d': FILTER_TYPE.OneDayBack,
    '3d': FILTER_TYPE.ThreeDaysBack,
    '1w': FILTER_TYPE.OneWeekBack,
    '2w': FILTER_TYPE.TwoWeeksBack,
    '1m': FILTER_TYPE.OneMonthBack,
   'all': FILTER_TYPE.NoFilter,
};

/**
 * This mapping is purely for logging purposes.
 */
var FILTER_TYPE_TO_STRING = {
  0: 'all messages',
  1: 'one day',
  2: 'three days',
  3: 'one week',
  4: 'two weeks',
  5: 'one month',
};

function ActiveSyncFolderConn(account, storage, _parentLog) {
  this._account = account;
  this._storage = storage;
  this._LOG = LOGFAB.ActiveSyncFolderConn(this, _parentLog, storage.folderId);

  this.folderMeta = storage.folderMeta;

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

  get serverId() {
    return this.folderMeta.serverId;
  },

  /**
   * Get the filter type for this folder. The account-level syncRange property
   * takes precedence here, but if it's set to "auto", we'll look at the
   * filterType on a per-folder basis. The per-folder filterType may be
   * undefined, in which case, we will attempt to infer a good filter type
   * elsewhere (see _inferFilterType()).
   */
  get filterType() {
    var syncRange = this._account.accountDef.syncRange;
    if (SYNC_RANGE_TO_FILTER_TYPE.hasOwnProperty(syncRange)) {
      var accountFilterType = SYNC_RANGE_TO_FILTER_TYPE[syncRange];
      if (accountFilterType)
        return accountFilterType;
      else
        return this.folderMeta.filterType;
    }
    else {
      console.warn('Got an invalid syncRange (' + syncRange +
                   ') using three days back instead');
      return $ascp.AirSync.Enums.FilterType.ThreeDaysBack;
    }
  },

  /**
   * Get the initial sync key for the folder so we can start getting data. We
   * assume we have already negotiated a connection in the caller.
   *
   * @param {string} filterType The filter type for our synchronization
   * @param {function} callback A callback to be run when the operation finishes
   */
  _getSyncKey: function asfc__getSyncKey(filterType, callback) {
    var folderConn = this;
    var account = this._account;
    var as = $ascp.AirSync.Tags;

    var w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(as.Sync)
       .stag(as.Collections)
         .stag(as.Collection)

    if (account.conn.currentVersion.lt('12.1'))
          w.tag(as.Class, 'Email');

          w.tag(as.SyncKey, '0')
           .tag(as.CollectionId, this.serverId)
           .stag(as.Options)
             .tag(as.FilterType, filterType)
           .etag()
         .etag()
       .etag()
     .etag();

    account.conn.postCommand(w, function(aError, aResponse) {
      if (aError) {
        console.error(aError);
        callback('unknown');
        return;
      }

      // Reset the SyncKey, just in case we don't see a sync key in the
      // response.
      folderConn.syncKey = '0';

      var e = new $wbxml.EventParser();
      e.addEventListener([as.Sync, as.Collections, as.Collection, as.SyncKey],
                         function(node) {
        folderConn.syncKey = node.children[0].textContent;
      });

      e.onerror = function() {}; // Ignore errors.
      e.run(aResponse);

      if (folderConn.syncKey === '0') {
        // We should never actually hit this, since it would mean that the
        // server is refusing to give us a sync key. On the off chance that we
        // do hit it, just bail.
        console.error('Unable to get sync key for folder');
        callback('unknown');
      }
      else {
        callback();
      }
    });
  },

  /**
   * Get an estimate of the number of messages to be synced.  We assume we have
   * already negotiated a connection in the caller.
   *
   * @param {string} filterType The filter type for our estimate
   * @param {function} callback A callback to be run when the operation finishes
   */
  _getItemEstimate: function asfc__getItemEstimate(filterType, callback) {
    var ie = $ascp.ItemEstimate.Tags;
    var as = $ascp.AirSync.Tags;

    var w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(ie.GetItemEstimate)
       .stag(ie.Collections)
         .stag(ie.Collection)
           .tag(as.SyncKey, this.syncKey)
           .tag(ie.CollectionId, this.serverId)
           .stag(as.Options)
             .tag(as.FilterType, filterType)
           .etag()
         .etag()
       .etag()
     .etag();

    this._account.conn.postCommand(w, function(aError, aResponse) {
      if (aError) {
        console.error(aError);
        callback('unknown');
        return;
      }

      var e = new $wbxml.EventParser();
      var base = [ie.GetItemEstimate, ie.Response];

      var status, estimate;
      e.addEventListener(base.concat(ie.Status), function(node) {
        status = node.children[0].textContent;
      });
      e.addEventListener(base.concat(ie.Collection, ie.Estimate),
                         function(node) {
        estimate = parseInt(node.children[0].textContent, 10);
      });

      try {
        e.run(aResponse);
      }
      catch (ex) {
        console.error('Error parsing GetItemEstimate response', ex, '\n',
                      ex.stack);
        callback('unknown');
        return;
      }

      if (status !== $ascp.ItemEstimate.Enums.Status.Success) {
        console.error('Error getting item estimate:', status);
        callback('unknown');
      }
      else {
        callback(null, estimate);
      }
    });
  },

  /**
   * Infer the filter type for this folder to get a sane number of messages.
   *
   * @param {function} callback A callback to be run when the operation
   *  finishes, taking two arguments: an error (if any), and the filter type we
   *  picked
   */
  _inferFilterType: function asfc__inferFilterType(callback) {
    var folderConn = this;
    var Type = $ascp.AirSync.Enums.FilterType;

    var getEstimate = function(filterType, onSuccess) {
      folderConn._getSyncKey(filterType, function(error) {
        if (error) {
          callback('unknown');
          return;
        }

        folderConn._getItemEstimate(filterType, function(error, estimate) {
          if (error) {
            callback('unknown');
            return;
          }

          onSuccess(estimate);
        });
      });
    };

    getEstimate(Type.TwoWeeksBack, function(estimate) {
      var messagesPerDay = estimate / 14; // Two weeks. Twoooo weeeeeeks.
      var filterType;

      if (estimate < 0)
        filterType = Type.ThreeDaysBack;
      else if (messagesPerDay >= DESIRED_MESSAGE_COUNT)
        filterType = Type.OneDayBack;
      else if (messagesPerDay * 3 >= DESIRED_MESSAGE_COUNT)
        filterType = Type.ThreeDaysBack;
      else if (messagesPerDay * 7 >= DESIRED_MESSAGE_COUNT)
        filterType = Type.OneWeekBack;
      else if (messagesPerDay * 14 >= DESIRED_MESSAGE_COUNT)
        filterType = Type.TwoWeeksBack;
      else if (messagesPerDay * 30 >= DESIRED_MESSAGE_COUNT)
        filterType = Type.OneMonthBack;
      else {
        getEstimate(Type.NoFilter, function(estimate) {
          var filterType;
          if (estimate > DESIRED_MESSAGE_COUNT) {
            filterType = Type.OneMonthBack;
            // Reset the sync key since we're changing filter types. This avoids
            // a round-trip where we'd normally get a zero syncKey from the
            // server.
            folderConn.syncKey = '0';
          }
          else {
            filterType = Type.NoFilter;
          }
          folderConn._LOG.inferFilterType(filterType);
          callback(null, filterType);
        });
        return;
      }

      if (filterType !== Type.TwoWeeksBack) {
        // Reset the sync key since we're changing filter types. This avoids a
        // round-trip where we'd normally get a zero syncKey from the server.
        folderConn.syncKey = '0';
      }
      folderConn._LOG.inferFilterType(filterType);
      callback(null, filterType);
    });
  },

  /**
   * Sync the folder with the server and enumerate all the changes since the
   * last sync.
   *
   * @param {function} callback A function to be called when the operation has
   *   completed, taking three arguments: |added|, |changed|, and |deleted|
   * @param {function} progress A function to be called as the operation
   *   progresses that takes a number in the range [0.0, 1.0] to express
   *   progress.
   */
  _enumerateFolderChanges: function asfc__enumerateFolderChanges(callback,
                                                                 progress) {
    var folderConn = this, storage = this._storage;

    if (!this._account.conn.connected) {
      this._account.conn.connect(function(error) {
        if (error) {
          callback('aborted');
          return;
        }
        folderConn._enumerateFolderChanges(callback, progress);
      });
      return;
    }
    if (!this.filterType) {
      this._inferFilterType(function(error, filterType) {
        if (error) {
          callback('unknown');
          return;
        }
        console.log('We want a filter of', FILTER_TYPE_TO_STRING[filterType]);
        folderConn.folderMeta.filterType = filterType;
        folderConn._enumerateFolderChanges(callback, progress);
      });
      return;
    }
    if (this.syncKey === '0') {
      this._getSyncKey(this.filterType, function(error) {
        if (error) {
          callback('aborted');
          return;
        }
        folderConn._enumerateFolderChanges(callback, progress);
      });
      return;
    }

    var as = $ascp.AirSync.Tags;
    var asEnum = $ascp.AirSync.Enums;
    var asb = $ascp.AirSyncBase.Tags;
    var asbEnum = $ascp.AirSyncBase.Enums;

    var w;

    // If the last sync was ours and we got an empty response back, we can send
    // an empty request to repeat our request. This saves a little bandwidth.
    if (this._account._syncsInProgress++ === 0 &&
        this._account._lastSyncKey === this.syncKey &&
        this._account._lastSyncFilterType === this.filterType &&
        this._account._lastSyncResponseWasEmpty) {
      w = as.Sync;
    }
    else {
      w = new $wbxml.Writer('1.3', 1, 'UTF-8');
      w.stag(as.Sync)
         .stag(as.Collections)
           .stag(as.Collection);

      if (this._account.conn.currentVersion.lt('12.1'))
            w.tag(as.Class, 'Email');

            w.tag(as.SyncKey, this.syncKey)
             .tag(as.CollectionId, this.serverId)
             .tag(as.GetChanges)
             .stag(as.Options)
               .tag(as.FilterType, this.filterType)

      // XXX: For some servers (e.g. Hotmail), we could be smart and get the
      // native body type (plain text or HTML), but Gmail doesn't seem to let us
      // do this. For now, let's keep it simple and always get HTML.
      if (this._account.conn.currentVersion.gte('12.0'))
              w.stag(asb.BodyPreference)
                 .tag(asb.Type, asbEnum.Type.HTML)
               .etag();

              w.tag(as.MIMESupport, asEnum.MIMESupport.Never)
               .tag(as.MIMETruncation, asEnum.MIMETruncation.NoTruncate)
             .etag()
           .etag()
         .etag()
       .etag();
    }

    this._account.conn.postCommand(w, function(aError, aResponse) {
      var added   = [];
      var changed = [];
      var deleted = [];
      var status;
      var moreAvailable = false;

      folderConn._account._syncsInProgress--;

      if (aError) {
        console.error('Error syncing folder:', aError);
        callback('aborted');
        return;
      }

      folderConn._account._lastSyncKey = folderConn.syncKey;
      folderConn._account._lastSyncFilterType = folderConn.filterType;

      if (!aResponse) {
        console.log('Sync completed with empty response');
        folderConn._account._lastSyncResponseWasEmpty = true;
        callback(null, added, changed, deleted);
        return;
      }

      folderConn._account._lastSyncResponseWasEmpty = false;
      var e = new $wbxml.EventParser();
      var base = [as.Sync, as.Collections, as.Collection];

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
        var id, guid, msg;

        for (var iter in Iterator(node.children)) {
          var child = iter[1];
          switch (child.tag) {
          case as.ServerId:
            guid = child.children[0].textContent;
            break;
          case as.ApplicationData:
            try {
              msg = folderConn._parseMessage(child, node.tag === as.Add);
            }
            catch (ex) {
              // If we get an error, just log it and skip this message.
              console.error('Failed to parse a message:', ex, '\n', ex.stack);
              return;
            }
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

        var collection = node.tag === as.Add ? added : changed;
        collection.push(msg);
      });

      e.addEventListener(base.concat(as.Commands, [[as.Delete, as.SoftDelete]]),
                         function(node) {
        var guid;

        for (var iter in Iterator(node.children)) {
          var child = iter[1];
          switch (child.tag) {
          case as.ServerId:
            guid = child.children[0].textContent;
            break;
          }
        }

        deleted.push(guid);
      });

      try {
        e.run(aResponse);
      }
      catch (ex) {
        console.error('Error parsing Sync response:', ex, '\n', ex.stack);
        callback('unknown');
        return;
      }

      if (status === asEnum.Status.Success) {
        console.log('Sync completed: added ' + added.length + ', changed ' +
                    changed.length + ', deleted ' + deleted.length);
        callback(null, added, changed, deleted, moreAvailable);
        if (moreAvailable)
          folderConn._enumerateFolderChanges(callback, progress);
      }
      else if (status === asEnum.Status.InvalidSyncKey) {
        console.warn('ActiveSync had a bad sync key');
        callback('badkey');
      }
      else {
        console.error('Something went wrong during ActiveSync syncing and we ' +
                      'got a status of ' + status);
        callback('unknown');
      }
    }, null, null,
    function progressData(bytesSoFar, totalBytes) {
      // We get the XHR progress status and convert it into progress in the
      // range [0.10, 0.80].  The remaining 20% is processing the specific
      // messages, but we don't bother to generate notifications since that
      // is done synchronously.
      if (!totalBytes)
        totalBytes = Math.max(1000000, bytesSoFar);
      progress(0.1 + 0.7 * bytesSoFar / totalBytes);
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
    var em = $ascp.Email.Tags;
    var asb = $ascp.AirSyncBase.Tags;
    var asbEnum = $ascp.AirSyncBase.Enums;

    var header, body, flagHeader;

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
        size: 0,
        to: null,
        cc: null,
        bcc: null,
        replyTo: null,
        attachments: [],
        relatedParts: [],
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
          for (var iter in Iterator(this.flags)) {
            var flagstate = iter[1];
            if (flagstate[1]) {
              o.flags.push(flagstate[0]);
            }
            else {
              var index = o.flags.indexOf(flagstate[0]);
              if (index !== -1)
                o.flags.splice(index, 1);
            }
          }

          // Merge everything else
          var skip = ['mergeInto', 'suid', 'srvid', 'guid', 'id', 'flags'];
          for (var iter in Iterator(this)) {
            var key = iter[0], value = iter[1];
            if (skip.indexOf(key) !== -1)
              continue;

            o[key] = value;
          }
        },
      };

      body = {
        mergeInto: function(o) {
          for (var iter in Iterator(this)) {
            var key = iter[0], value = iter[1];
            if (key === 'mergeInto') continue;
            o[key] = value;
          }
        },
      };

      flagHeader = function(flag, state) {
        header.flags.push([flag, state]);
      }
    }

    var bodyType, bodyText;

    for (var iter in Iterator(node.children)) {
      var child = iter[1];
      var childText = child.children.length ? child.children[0].textContent :
                                              null;

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
        for (var iter2 in Iterator(child.children)) {
          var grandchild = iter2[1];
          if (grandchild.tag === em.Status)
            flagHeader('\\Flagged', grandchild.children[0].textContent !== '0');
        }
        break;
      case asb.Body: // ActiveSync 12.0+
        for (var iter2 in Iterator(child.children)) {
          var grandchild = iter2[1];
          switch (grandchild.tag) {
          case asb.Type:
            bodyType = grandchild.children[0].textContent;
            break;
          case asb.Data:
            bodyText = grandchild.children[0].textContent;
            break;
          }
        }
        break;
      case em.Body: // pre-ActiveSync 12.0
        bodyType = asbEnum.Type.PlainText;
        bodyText = childText;
        break;
      case asb.Attachments: // ActiveSync 12.0+
      case em.Attachments:  // pre-ActiveSync 12.0
        for (var iter2 in Iterator(child.children)) {
          var attachmentNode = iter2[1];
          if (attachmentNode.tag !== asb.Attachment &&
              attachmentNode.tag !== em.Attachment)
            continue;

          var attachment = {
            name: null,
            contentId: null,
            type: null,
            part: null,
            encoding: null,
            sizeEstimate: null,
            file: null,
          };

          var isInline = false;
          for (var iter3 in Iterator(attachmentNode.children)) {
            var attachData = iter3[1];
            var dot, ext;
            var attachDataText = attachData.children.length ?
                                 attachData.children[0].textContent : null;

            switch (attachData.tag) {
            case asb.DisplayName:
            case em.DisplayName:
              attachment.name = attachDataText;

              // Get the file's extension to look up a mimetype, but ignore it
              // if the filename is of the form '.bashrc'.
              dot = attachment.name.lastIndexOf('.');
              ext = dot > 0 ? attachment.name.substring(dot + 1) : '';
              attachment.type = $mimelib.contentTypes[ext] ||
                                'application/octet-stream';
              break;
            case asb.FileReference:
            case em.AttName:
              attachment.part = attachDataText;
              break;
            case asb.EstimatedDataSize:
            case em.AttSize:
              attachment.sizeEstimate = parseInt(attachDataText, 10);
              break;
            case asb.ContentId:
              attachment.contentId = attachDataText;
              break;
            case asb.IsInline:
              isInline = (attachDataText === '1');
              break;
            case asb.FileReference:
            case em.Att0Id:
              attachment.part = attachData.children[0].textContent;
              break;
            }
          }

          if (isInline)
            body.relatedParts.push(attachment);
          else
            body.attachments.push(attachment);
        }
        header.hasAttachments = body.attachments.length > 0;
        break;
      }
    }

    // Process the body as needed.
    if (bodyType === asbEnum.Type.PlainText) {
      var bodyRep = $quotechew.quoteProcessTextBody(bodyText);
      header.snippet = $quotechew.generateSnippet(bodyRep,
                                                  DESIRED_SNIPPET_LENGTH);
      body.bodyReps = ['plain', bodyRep];
    }
    else if (bodyType === asbEnum.Type.HTML) {
      var htmlNode = $htmlchew.sanitizeAndNormalizeHtml(bodyText);
      header.snippet = $htmlchew.generateSnippet(htmlNode,
                                                 DESIRED_SNIPPET_LENGTH);
      body.bodyReps = ['html', htmlNode.innerHTML];
    }

    return { header: header, body: body };
  },

  sync: function asfc_sync(accuracyStamp, doneCallback, progressCallback) {
    var folderConn = this,
        addedMessages = 0,
        changedMessages = 0,
        deletedMessages = 0;

    this._LOG.sync_begin(null, null, null);
    this._enumerateFolderChanges(function (error, added, changed, deleted,
                                           moreAvailable) {
      var storage = folderConn._storage;

      if (error === 'badkey') {
        folderConn._account._recreateFolder(storage.folderId, function(s) {
          // If we got a bad sync key, we'll end up creating a new connection,
          // so just clear out the old storage to make this connection unusable.
          folderConn._storage = null;
          folderConn._LOG.sync_end(null, null, null);
        });
        return;
      }
      else if (error) {
        doneCallback(error);
        return;
      }

      for (var iter in Iterator(added)) {
        var message = iter[1];
        // If we already have this message, it's probably because we moved it as
        // part of a local op, so let's assume that the data we already have is
        // ok. XXX: We might want to verify this, to be safe.
        if (storage.hasMessageWithServerId(message.header.srvid))
          continue;

        storage.addMessageHeader(message.header);
        storage.addMessageBody(message.header, message.body);
        addedMessages++;
      }

      for (var iter in Iterator(changed)) {
        var message = iter[1];
        // If we don't know about this message, just bail out.
        if (!storage.hasMessageWithServerId(message.header.srvid))
          continue;

        storage.updateMessageHeaderByServerId(message.header.srvid, true,
                                              function(oldHeader) {
          message.header.mergeInto(oldHeader);
          return true;
        });
        changedMessages++;
        // XXX: update bodies
      }

      for (var iter in Iterator(deleted)) {
        var messageGuid = iter[1];
        // If we don't know about this message, it's probably because we already
        // deleted it.
        if (!storage.hasMessageWithServerId(messageGuid))
          continue;

        storage.deleteMessageByServerId(messageGuid);
        deletedMessages++;
      }

      if (!moreAvailable) {
        var messagesSeen = addedMessages + changedMessages + deletedMessages;

        // Note: For the second argument here, we report the number of messages
        // we saw that *changed*. This differs from IMAP, which reports the
        // number of messages it *saw*.
        folderConn._LOG.sync_end(addedMessages, changedMessages,
                                 deletedMessages);
        storage.markSyncRange($sync.OLDEST_SYNC_DATE, accuracyStamp, 'XXX',
                              accuracyStamp);
        doneCallback(null, null, messagesSeen);
      }
    },
    progressCallback);
  },

  performMutation: function(invokeWithWriter, callWhenDone) {
    var folderConn = this;
    if (!this._account.conn.connected) {
      this._account.conn.connect(function(error) {
        if (error) {
          callback('unknown');
          return;
        }
        folderConn.performMutation(invokeWithWriter, callWhenDone);
      });
      return;
    }

    var as = $ascp.AirSync.Tags;

    var w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(as.Sync)
       .stag(as.Collections)
         .stag(as.Collection);

    if (this._account.conn.currentVersion.lt('12.1'))
          w.tag(as.Class, 'Email');

          w.tag(as.SyncKey, this.syncKey)
           .tag(as.CollectionId, this.serverId)
           // Use DeletesAsMoves in non-trash folders. Don't use it in trash
           // folders because that doesn't make any sense.
           .tag(as.DeletesAsMoves, this.folderMeta.type === 'trash' ? '0' : '1')
           // GetChanges defaults to true, so we must explicitly disable it to
           // avoid hearing about changes.
           .tag(as.GetChanges, '0')
           .stag(as.Commands);

    try {
      invokeWithWriter(w);
    }
    catch (ex) {
      console.error('Exception in performMutation callee:', ex,
                    '\n', ex.stack);
      callWhenDone('unknown');
      return;
    }

           w.etag(as.Commands)
         .etag(as.Collection)
       .etag(as.Collections)
     .etag(as.Sync);

    this._account.conn.postCommand(w, function(aError, aResponse) {
      if (aError) {
        console.error('postCommand error:', aError);
        callWhenDone('unknown');
        return;
      }

      var e = new $wbxml.EventParser();
      var syncKey, status;

      var base = [as.Sync, as.Collections, as.Collection];
      e.addEventListener(base.concat(as.SyncKey), function(node) {
        syncKey = node.children[0].textContent;
      });
      e.addEventListener(base.concat(as.Status), function(node) {
        status = node.children[0].textContent;
      });

      try {
        e.run(aResponse);
      }
      catch (ex) {
        console.error('Error parsing Sync response:', ex, '\n', ex.stack);
        callWhenDone('unknown');
        return;
      }

      if (status === $ascp.AirSync.Enums.Status.Success) {
        folderConn.syncKey = syncKey;
        if (callWhenDone)
          callWhenDone(null);
      }
      else {
        console.error('Something went wrong during ActiveSync syncing and we ' +
                      'got a status of ' + status);
        callWhenDone('status:' + status);
      }
    });
  },

  // XXX: take advantage of multipart responses here.
  // See http://msdn.microsoft.com/en-us/library/ee159875%28v=exchg.80%29.aspx
  downloadMessageAttachments: function(uid, partInfos, callback, progress) {
    var folderConn = this;
    if (!this._account.conn.connected) {
      this._account.conn.connect(function(error) {
        if (error) {
          callback('unknown');
          return;
        }
        folderConn.downloadMessageAttachments(uid, partInfos, callback,
                                              progress);
      });
      return;
    }

    var io = $ascp.ItemOperations.Tags;
    var ioStatus = $ascp.ItemOperations.Enums.Status;
    var asb = $ascp.AirSyncBase.Tags;

    var w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(io.ItemOperations);
    for (var iter in Iterator(partInfos)) {
      var part = iter[1];
      w.stag(io.Fetch)
         .tag(io.Store, 'Mailbox')
         .tag(asb.FileReference, part.part)
       .etag();
    }
    w.etag();

    this._account.conn.postCommand(w, function(aError, aResult) {
      if (aError) {
        console.error('postCommand error:', aError);
        callback('unknown');
        return;
      }

      var globalStatus;
      var attachments = {};

      var e = new $wbxml.EventParser();
      e.addEventListener([io.ItemOperations, io.Status], function(node) {
        globalStatus = node.children[0].textContent;
      });
      e.addEventListener([io.ItemOperations, io.Response, io.Fetch],
                         function(node) {
        var part = null, attachment = {};

        for (var iter in Iterator(node.children)) {
          var child = iter[1];
          switch (child.tag) {
          case io.Status:
            attachment.status = child.children[0].textContent;
            break;
          case asb.FileReference:
            part = child.children[0].textContent;
            break;
          case io.Properties:
            var contentType = null, data = null;

            for (var iter2 in Iterator(child.children)) {
              var grandchild = iter2[1];
              var textContent = grandchild.children[0].textContent;

              switch (grandchild.tag) {
              case asb.ContentType:
                contentType = textContent;
                break;
              case io.Data:
                data = new Buffer(textContent, 'base64');
                break;
              }
            }

            if (contentType && data)
              attachment.data = new Blob([data], { type: contentType });
            break;
          }

          if (part)
            attachments[part] = attachment;
        }
      });
      e.run(aResult);

      var error = globalStatus !== ioStatus.Success ? 'unknown' : null;
      var bodies = [];
      for (var iter in Iterator(partInfos)) {
        var part = iter[1];
        if (attachments.hasOwnProperty(part.part) &&
            attachments[part.part].status === ioStatus.Success) {
          bodies.push(attachments[part.part].data);
        }
        else {
          error = 'unknown';
          bodies.push(null);
        }
      }
      callback(error, bodies);
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
  /**
   * Can we synchronize?  Not if we don't have a server id!
   */
  get syncable() {
    return this.folderConn.serverId !== null;
  },

  /**
   * Can we grow this sync range?  Not in ActiveSync land!
   */
  get canGrowSync() {
    return false;
  },

  initialSync: function(slice, initialDays, syncCallback,
                        doneCallback, progressCallback) {
    syncCallback('sync', false, true);
    this.folderConn.sync(
      $date.NOW(),
      this.onSyncCompleted.bind(this, doneCallback, true),
      progressCallback);
  },

  refreshSync: function(slice, dir, startTS, endTS, origStartTS,
                        doneCallback, progressCallback) {
    this.folderConn.sync(
      $date.NOW(),
      this.onSyncCompleted.bind(this, doneCallback, false),
      progressCallback);
  },

  // Returns false if no sync is necessary.
  growSync: function(slice, growthDirection, anchorTS, syncStepDays,
                     doneCallback, progressCallback) {
    // ActiveSync is different, and trying to sync more doesn't work with it.
    // Just assume we've got all we need.
    // (There is no need to invoke the callbacks; by returning false, we
    // indicate that we did no work.)
    return false;
  },

  /**
   * Whatever synchronization we last triggered has now completed; we should
   * either trigger another sync if we still want more data, or close out the
   * current sync.
   */
  onSyncCompleted: function ifs_onSyncCompleted(doneCallback, initialSync,
                                                err, bisectInfo, messagesSeen) {
    var storage = this.folderStorage;
    console.log("Sync Completed!", messagesSeen, "messages synced");

    // Expand the accuracy range to cover everybody.
    if (!err)
      storage.markSyncedToDawnOfTime();
    // Always save state, although as an optimization, we could avoid saving state
    // if we were sure that our state with the server did not advance.
    this._account.__checkpointSyncCompleted();

    if (err) {
      doneCallback(err);
      return;
    }

    if (initialSync) {
      storage._curSyncSlice.ignoreHeaders = false;
      storage._curSyncSlice.waitingOnData = 'db';

      storage.getMessagesInImapDateRange(
        0, null, $sync.INITIAL_FILL_SIZE, $sync.INITIAL_FILL_SIZE,
        // Don't trigger a refresh; we just synced.  Accordingly, releaseMutex can
        // be null.
        storage.onFetchDBHeaders.bind(storage, storage._curSyncSlice, false,
                                      doneCallback, null)
      );
    }
    else {
      doneCallback(err);
    }
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
      inferFilterType: { filterType: false },
    },
    asyncJobs: {
      sync: {
        newMessages: true, changedMessages: true, deletedMessages: true,
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

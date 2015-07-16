define(
  [
    'logic',
    '../date',
    '../syncbase',
    '../allback',
    '../db/mail_rep',
    'activesync/codepages/AirSync',
    'activesync/codepages/AirSyncBase',
    'activesync/codepages/ItemEstimate',
    'activesync/codepages/Email',
    'activesync/codepages/ItemOperations',
    'safe-base64',
    'mimetypes',
    'module',
    'require',
    'exports'
  ],
  function(
    logic,
    $date,
    $sync,
    allback,
    mailRep,
    $AirSync,
    $AirSyncBase,
    $ItemEstimate,
    $Email,
    $ItemOperations,
    safeBase64,
    mimetypes,
    $module,
    require,
    exports
  ) {
'use strict';


/**
 * This is minimum number of messages we'd like to get for a folder for a given
 * sync range. It's not exact, since we estimate from the number of messages in
 * the past two weeks, but it's close enough.
 */
var DESIRED_MESSAGE_COUNT = 50;

/**
 * Filter types are lazy initialized once the activesync code is loaded.
 */
var FILTER_TYPE, SYNC_RANGE_TO_FILTER_TYPE, FILTER_TYPE_TO_STRING;
function initFilterTypes() {
  FILTER_TYPE = $AirSync.Enums.FilterType;

  /**
   * Map our built-in sync range values to their corresponding ActiveSync
   * FilterType values. We exclude 3 and 6 months, since they aren't valid for
   * email.
   *
   * Also see SYNC_RANGE_ENUMS_TO_MS in `syncbase.js`.
   */
  SYNC_RANGE_TO_FILTER_TYPE = {
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
  FILTER_TYPE_TO_STRING = {
    0: 'all messages',
    1: 'one day',
    2: 'three days',
    3: 'one week',
    4: 'two weeks',
    5: 'one month',
  };
}

var $wbxml, parseAddresses, $mailchew;

function lazyConnection(cbIndex, fn, failString) {
  return function lazyRun() {
    var args = Array.slice(arguments),
        errback = args[cbIndex],
        self = this;

    require(['wbxml', 'addressparser', '../bodies/mailchew'],
    function (wbxml, addressparser, mailchew) {
      if (!$wbxml) {
        $wbxml = wbxml;
        parseAddresses = addressparser.parse.bind(addressparser);
        $mailchew = mailchew;
        initFilterTypes();
      }

      self._account.withConnection(errback, function () {
        fn.apply(self, args);
      }, failString);
    });
  };
}


function ActiveSyncFolderConn(account, storage) {
  this._account = account;
  this._storage = storage;
  logic.defineScope(this, 'ActiveSyncFolderConn',
                    { folderId: storage.folderId,
                      accountId: account.id });

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
   * TODO: this logic is currently orphaned; its intent needs to be migrated.
   *
   * Get the filter type for this folder. The account-level syncRange property
   * takes precedence here, but if it's set to "auto", we'll look at the
   * filterType on a per-folder basis. The per-folder filterType may be
   * undefined, in which case, we will attempt to infer a good filter type
   * elsewhere (see _inferFilterType()).
   * ASSUMES that it is only called after lazy load of activesync code and
   * initFilterTypes() has been run.
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
      return $AirSync.Enums.FilterType.ThreeDaysBack;
    }
  },

  /**
   * Download the bodies for a set of headers.
   *
   * XXX This method is a slightly modified version of
   * ImapFolderConn._lazyDownloadBodies; we should attempt to remove the
   * duplication.
   */
  downloadBodies: function(headers, options, callback) {
    if (this._account.conn.currentVersion.lt('12.0'))
      return this._syncBodies(headers, callback);

    var downloadsNeeded = 0,
        folderConn = this;

    var latch = allback.latch();
    for (var i = 0; i < headers.length; i++) {
      var header = headers[i];
      // We obviously can't do anything with null header references.
      // To avoid redundant work, we also don't want to do any fetching if we
      // already have a snippet.  This could happen because of the extreme
      // potential for a caller to spam multiple requests at us before we
      // service any of them.  (Callers should only have one or two outstanding
      // jobs of this and do their own suppression tracking, but bugs happen.)
      if (!header || header.snippet !== null) {
        continue;
      }

      // This isn't absolutely guaranteed to be 100% correct, but is good enough
      // for indicating to the caller that we did some work.
      downloadsNeeded++;
      this.downloadBodyReps(header, options, latch.defer(header.suid));
    }
    latch.then(function(results) {
      callback(allback.extractErrFromCallbackArgs(results), downloadsNeeded);
    });
  },

  downloadBodyReps: lazyConnection(1, function(header, options, callback) {
    var folderConn = this;
    var account = this._account;

    if (account.conn.currentVersion.lt('12.0'))
      return this._syncBodies([header], callback);

    if (typeof(options) === 'function') {
      callback = options;
      options = null;
    }
    options = options || {};

    var io = $ItemOperations.Tags;
    var ioEnum = $ItemOperations.Enums;
    var as = $AirSync.Tags;
    var asEnum = $AirSync.Enums;
    var asb = $AirSyncBase.Tags;
    var Type = $AirSyncBase.Enums.Type;

    var gotBody = function gotBody(bodyInfo) {
      if (!bodyInfo)
        return callback('unknown');

      // ActiveSync only stores one body rep, no matter how many body parts the
      // MIME message actually has.
      var bodyRep = bodyInfo.bodyReps[0];
      var bodyType = bodyRep.type === 'html' ? Type.HTML : Type.PlainText;

      var truncationSize;

      // If the body is bigger than the max size, grab a small bit of plain text
      // to show as the snippet.
      if (options.maximumBytesToFetch < bodyRep.sizeEstimate) {
        bodyType = Type.PlainText;
        truncationSize = DESIRED_TEXT_SNIPPET_BYTES;
      }

      var w = new $wbxml.Writer('1.3', 1, 'UTF-8');
      w.stag(io.ItemOperations)
         .stag(io.Fetch)
           .tag(io.Store, 'Mailbox')
           .tag(as.CollectionId, folderConn.serverId)
           .tag(as.ServerId, header.srvid)
           .stag(io.Options)
             // Only get the AirSyncBase:Body element to minimize bandwidth.
             .stag(io.Schema)
               .tag(asb.Body)
             .etag()
             .stag(asb.BodyPreference)
               .tag(asb.Type, bodyType);

      if (truncationSize)
              w.tag(asb.TruncationSize, truncationSize);

            w.etag()
           .etag()
         .etag()
       .etag();

      account.conn.postCommand(w, function(aError, aResponse) {
        if (aError) {
          console.error(aError);
          account._reportErrorIfNecessary(aError);
          callback('unknown');
          return;
        }

        var status, bodyContent, parseError,
            e = new $wbxml.EventParser();
        e.addEventListener([io.ItemOperations, io.Status], function(node) {
          status = node.children[0].textContent;
        });
        e.addEventListener([io.ItemOperations, io.Response, io.Fetch,
                            io.Properties, asb.Body, asb.Data], function(node) {
          bodyContent = node.children[0].textContent;
        });

        try {
          e.run(aResponse);
        }
        catch (ex) {
          return callback('unknown');
        }

        if (status !== ioEnum.Status.Success)
          return callback('unknown');

        folderConn._updateBody(header, bodyInfo, bodyContent, !!truncationSize,
                               callback);
      });
    };

    this._storage.getMessageBody(header.suid, header.date, gotBody);
  }),

  /**
   * Determine whether an activesync header represents a read message.
   * ActiveSync has an different header flag formant: ['flag', true/false].
   */
  _activeSyncHeaderIsSeen: function(header) {
    for (var i = 0; i < header.flags.length; i++) {
      if (header.flags[i][0] === '\\Seen' && header.flags[i][1]) {
        return true;
      }
    }
    return false;
  },

  _updateBody: function(header, bodyInfo, bodyContent, snippetOnly, callback) {
    var bodyRep = bodyInfo.bodyReps[0];

    // We neither need to store or want to deal with \r in the processing of
    // the body.
    bodyContent = bodyContent.replace(/\r/g, '');

    var type = snippetOnly ? 'plain' : bodyRep.type;
    var data = $mailchew.processMessageContent(bodyContent, type, !snippetOnly,
                                               true, this._LOG);

    header.snippet = data.snippet;
    bodyRep.isDownloaded = !snippetOnly;
    bodyRep.amountDownloaded = bodyContent.length;
    if (!snippetOnly)
      bodyRep.content = data.content;

    var event = {
      changeDetails: {
        bodyReps: [0]
      }
    };

    var latch = allback.latch();
    this._storage.updateMessageHeader(header.date, header.id, false, header,
                                      bodyInfo, latch.defer('header'));
    this._storage.updateMessageBody(header, bodyInfo, {}, event,
                                    latch.defer('body'));
    latch.then(callback.bind(null, null, bodyInfo, /* flushed */ false));
  },

  // XXX: take advantage of multipart responses here.
  // See http://msdn.microsoft.com/en-us/library/ee159875%28v=exchg.80%29.aspx
  downloadMessageAttachments: lazyConnection(2, function(uid,
                                                         partInfos,
                                                         callback,
                                                         progress) {
    var folderConn = this;

    var io = $ItemOperations.Tags;
    var ioStatus = $ItemOperations.Enums.Status;
    var asb = $AirSyncBase.Tags;

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
        folderConn._account._reportErrorIfNecessary(aError);
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
                data = safeBase64.decode(textContent);
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
  }),
};

function ActiveSyncFolderSyncer(account, folderStorage) {
  this._account = account;
  this.folderStorage = folderStorage;

  logic.defineScope(this, 'ActiveSyncFolderSyncer',
                    { accountId: account.id,
                      folderId: folderStorage.folderId });

  this.folderConn = new ActiveSyncFolderConn(account, folderStorage);
}
exports.ActiveSyncFolderSyncer = ActiveSyncFolderSyncer;
ActiveSyncFolderSyncer.prototype = {
  /**
   * Can we synchronize?  Not if we don't have a server id!  (This happens for
   * the inbox when it is speculative before our first syncFolderList.)
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
    syncCallback('sync', true /* Ignore Headers */);
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

    // Always save state, although as an optimization, we could avoid saving
    // state if we were sure that our state with the server did not advance.
    // Do not call our callback until the save has completed.
    this._account.__checkpointSyncCompleted(function() {
      if (err) {
        doneCallback(err);
      }
      else if (initialSync) {
        storage._curSyncSlice.ignoreHeaders = false;
        storage._curSyncSlice.waitingOnData = 'db';

        // TODO: We could potentially shave some latency by doing the DB fetch
        // but deferring the doneCallback until the checkpoint has notified.
        // I'm copping out on this right now because there may be some nuances
        // in there that I would like to think about more and this is also not
        // a major slowdown concern.  We're already slow here and the more
        // important thing for us to do would just be to trigger the initial
        // sync much earlier in the UI process to save even more time.
        storage.getMessagesInImapDateRange(
          0, null, $sync.INITIAL_FILL_SIZE, $sync.INITIAL_FILL_SIZE,
          // Don't trigger a refresh; we just synced.  Accordingly,
          // releaseMutex can be null.
          storage.onFetchDBHeaders.bind(storage, storage._curSyncSlice, false,
                                        doneCallback, null)
        );
      }
      else {
        doneCallback(err);
      }
    });
  },

  allConsumersDead: function() {
  },

  shutdown: function() {
    this.folderConn.shutdown();
  }
};

}); // end define

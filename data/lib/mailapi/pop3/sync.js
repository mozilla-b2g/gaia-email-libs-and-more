define(['rdcommon/log', '../util', 'module', 'require', 'exports',
        '../mailchew', '../syncbase', '../date', '../jobmixins',
        '../allback', 'pop3/pop3'],
function(log, util, module, require, exports,
         mailchew, sync, date, jobmixins,
         allback, pop3) {

/**
 * Manage the synchronization process for POP3 accounts. In IMAP and
 * ActiveSync, the work of this class is split in two (a `folderConn`
 * and syncer), but since POP3 has no concept of folders, the syncer
 * manages everything itself.
 *
 * This class still gets created for each folder for compatibiliy with
 * IMAP/ActiveSync, but we fast-path out of sync operations if the
 * folder we're looking at isn't the inbox.
 */
function Pop3FolderSyncer(account, storage, _parentLog) {
  this._LOG = LOGFAB.Pop3FolderSyncer(this, _parentLog, storage.folderId);
  this.account = account;
  this.storage = storage;
  // Only sync folders if this is the inbox. Other folders are client-side only.
  this.isInbox = (storage.folderMeta.type === 'inbox');
}
exports.Pop3FolderSyncer = Pop3FolderSyncer;

/**
 * Wrap a function with connection handling, as follows:
 * - If a successful connection can be established, fn gets called with
 *   a connection and the rest of the arguments. The argument at index
 *   cbIndex is wrapped to automatically call the connection `done`
 *   callback.
 * - If connection fails, the argument at index cbIndex is called with
 *   the connection error.
 *
 * @param {boolean} getNew If a fresh connection should always be made.
 * @param {int} cbIndex Index of the parent function's callback in args
 */
function lazyWithConnection(getNew, cbIndex, fn) {
  return function pop3LazyWithConnection() {
    var args = Array.slice(arguments);
    require([], function () {
      var next = function() {
        this.account.withConnection(function (err, conn, done) {
          var callback = args[cbIndex];
          if (err) {
            callback && callback(err);
          } else {
            args[cbIndex] = function lazyDone() {
              done();
              callback && callback();
            };
            fn.apply(this, [conn].concat(args));
          }
        }.bind(this));
      }.bind(this);

      // if we require a fresh connection, close out the old one first.
      if (getNew && this.account._conn &&
          this.account._conn.state !== 'disconnected') {
        this.account._conn.quit(next);
      } else {
        next();
      }
    }.bind(this));
  };
};

Pop3FolderSyncer.prototype = {
  syncable: true,
  canGrowSync: false, // not relevant for POP3

  /**
   * Given a list of messages, download snippets for those that don't
   * already have snippets. You need to pass an options argument so we
   * only download a snippet. If you don't do that, you are doing
   * something wrong. downloadBodyReps is the one that is for full
   * body part/message downloading. XXX rename this family of methods.
   */
  downloadBodies: lazyWithConnection(/* getNew = */ false, /* cbIndex = */ 2,
  function(conn, headers, options, callback) {
    var latch = allback.latch();
    var storage = this.storage;

    for (var i = 0; i < headers.length; i++) {
      if (headers[i] && headers[i].snippet == null) {
        this.downloadBodyReps(headers[i], options, latch.defer(i));
      }
    }

    latch.then(function(results) {
      var err = null; // pull out the first error, if it exists
      for (var k in results) {
        err = results[k][0];
      }
      storage.runAfterDeferredCalls(function() {
        callback(err, headers.length);
      });
    });
  }),

  /**
   * Download the full body of a message. POP3 does not distinguish
   * between message bodies and attachments, so we must retrieve them
   * all in one go.
   */
  downloadBodyReps: lazyWithConnection(/* getNew = */ false, /* cbIndex = */ 2,
  function(conn, header, options, callback) {
    if (options instanceof Function) {
      callback = options;
      options = {};
    }

    console.log('POP3: Downloading bodyReps for UIDL ' + header.srvid);

    conn.downloadMessageByUidl(header.srvid, function(err, message) {
      if (err) { callback(err); return; }
      // Don't overwrite the header, because it contains useful
      // identifiers like `suid` and things we want. Plus, with POP3,
      // the server's headers will always be the same.
      // However, we do need header.bytesToDownloadForBodyDisplay:
      header.bytesToDownloadForBodyDisplay =
        message.header.bytesToDownloadForBodyDisplay;
      console.log('POP3: Storing message ' + header.srvid +
                  ' with ' + header.bytesToDownloadForBodyDisplay +
                  ' bytesToDownload.');
      this.storeMessage(header, message.bodyInfo, function() {
        callback && callback(null, message.bodyInfo);
      });
    }.bind(this));
  }),

  downloadMessageAttachments: function(uid, partInfos, callback, progress) {
    // We already retrieved the attachments in downloadBodyReps, so
    // this function should never be invoked (because callers would
    // have seen that all relevant partInfos have set `isDownloaded`
    // to true). Either way, there's nothing to do here.
    console.log('POP3: ERROR: downloadMessageAttachments called and ' +
                'POP3 shouldn\'t do that.');
    callback(null, null);
  },

  /**
   * Store a message. Depending on whether or not we've seen the
   * message before, we'll either add it as a new message in storage
   * or update the existing one.
   *
   * Our current POP3 implementation does not automatically delete
   * messages from the server when they've been fetched, so we need to
   * track which messages we've downloaded already and which ones are
   * new. Unfortunately, this means that our sync with the server will
   * take progressively longer as the server accumulates more messages
   * in its store.
   *
   * Some servers might potentially "window" messages, such that the
   * oldest messages in the message list might just drop off the
   * server's list. If so, this code doesn't change; new messages will
   * continue to be newly stored, and old messages will still be
   * known.
   *
   * @param {HeaderInfo} header Message header.
   * @param {BodyInfo} bodyInfo Body information, reps, etc.
   * @param {function()} callback
   */
  storeMessage: function(header, bodyInfo, callback) {
    callback = callback || function() {};
    var event = {
      changeDetails: {}
    };

    var knownId = this.getMessageIdForUidl(header.srvid);

    if (header.id == null) { // might be zero.
      if (knownId == null) {
        header.id = this.storage._issueNewHeaderId();
      } else {
        header.id = knownId;
      }
      header.suid = this.storage.folderId + '/' + header.id;
      header.guid = header.guid || header.srvid;
    }

    // Save all included attachments before actually storing the
    // message. Downloaded attachments must be converted from a blob
    // to a file on disk.
    var latch = allback.latch();
    var self = this;

    for (var i = 0; i < bodyInfo.attachments.length; i++) {
      var att = bodyInfo.attachments[i];
      if (att.file instanceof Blob) {
        // We want to save attachments to device storage (sdcard),
        // rather than IndexedDB. NB: This will change when download
        // manager comes.
        console.log('Saving attachment', att.file);
        jobmixins.saveToDeviceStorage(
          this._LOG, att.file, 'sdcard', att.name, att, latch.defer());
        // When saveToDeviceStorage completes, att.file will
        // be a reference to the file on the sdcard.
      }
    }

    latch.then(function() {
      // Once the attachments have been downloaded, we can store the
      // message. Here, we wait to call back from storeMessage() until
      // we've saved _both_ the header and body.
      latch = allback.latch();

      if (knownId == null) {
        self.storeMessageUidlForMessageId(header.srvid, header.id);
        self.storage.addMessageHeader(header, latch.defer());
        self.storage.addMessageBody(header, bodyInfo, latch.defer());
      } else {
        self.storage.updateMessageHeader(
          header.date, header.id, true, header, latch.defer());
        event.changeDetails.attachments = range(bodyInfo.attachments.length);
        event.changeDetails.bodyReps = range(bodyInfo.bodyReps.length);
        self.storage.updateMessageBody(
          header, bodyInfo, event, latch.defer());
      }

      latch.then(function() {
        callback(null, bodyInfo);
      });
    });
  },

  /**
   * Retrieve the message's id (header.id) given a server's UIDL.
   *
   * CAUTION: Zero is a valid message ID. I made the mistake of doing
   * boolean comparisons on header IDs and that is a BAD IDEA. <3
   * Hence the `== null` checks in a few places in this file.
   */
  getMessageIdForUidl: function(uidl) {
    if (uidl == null) {
      return null;
    }
    var inboxMeta = this.account.getFolderMetaForFolderId(
      this.account.getFirstFolderWithType('inbox').id);
    inboxMeta.uidlMap = inboxMeta.uidlMap || {};
    return inboxMeta.uidlMap[uidl];
  },

  /**
   * Store the given message UIDL so that we know it has already been
   * downloaded.
   */
  storeMessageUidlForMessageId: function(uidl, headerId) {
    var inboxMeta = this.account.getFolderMetaForFolderId(
      this.account.getFirstFolderWithType('inbox').id);
    inboxMeta.uidlMap = inboxMeta.uidlMap || {};
    inboxMeta.uidlMap[uidl] = headerId;
  },

  /**
   * Sync the inbox for the first time. Since we set `ignoreHeaders`
   * to true, we'll notify mail slices to update after the entire sync
   * completes, so that all messages show up at once rather than one
   * at a time.
   */
  initialSync: function(slice, initialDays, syncCb, doneCb, progressCb) {
    syncCb('sync', false /* accumulateMode */, true /* ignoreHeaders */);
    this.sync(true, slice, doneCb, progressCb);
  },

  /**
   * Sync the inbox for a refresh. This is the same as initialSync for
   * POP3, except that we notify slices immediately upon receiving
   * each new message individually.
   */
  refreshSync: function(
      slice, dir, startTS, endTS, origStartTS, doneCb, progressCb) {
    this.sync(false, slice, doneCb, progressCb);
  },

  /**
   * The unit tests issue "delete on server but not locally" commands.
   * In order to mimic operations where we modify non-INBOX folders on
   * the server and expect to learn about them from the client on
   * sync, we queue up "server-only" modifications and execute them
   * upon sync. This allows us to reuse much of the existing tests for
   * certain folder operations, and becomes a no-op in production.
   */
  _performTestDeletions: function(cb) {
    var meta = this.storage.folderMeta;
    var callbacksWaiting = 1;
    var numAdds = 0;
    var latch = allback.latch();
    if (meta._TEST_pendingHeaderDeletes) {
      meta._TEST_pendingHeaderDeletes.forEach(function(header) {
        callbacksWaiting++;
        this.storage.deleteMessageHeaderUsingHeader(header, latch.defer());
      }, this);
      meta._TEST_pendingHeaderDeletes = null;
    }
    if (meta._TEST_pendingAdds) {
      meta._TEST_pendingAdds.forEach(function(msg) {
        callbacksWaiting++;
        this.storeMessage(msg.header, msg.bodyInfo, latch.defer());
      }, this);
      meta._TEST_pendingAdds = null;
    }
    latch.then(function(results) { cb(); });
  },

  /**
   * Irrelevant for POP3.
   */
  growSync: function(slice, growthDirection, anchorTS, syncStepDays,
                     doneCallback, progressCallback) {
    return false; // No need to invoke the callbacks.
  },

  allConsumersDead: function() {
    // Nothing to do here.
  },

  shutdown: function() {
    // No real cleanup necessary here; just log that we died.
    this._LOG.__die();
  },

  /**
   * Pull down new headers from the server, attempting to fetch
   * snippets for the messages.
   *
   * Pop3Client (in pop3.js) contains the variables used to determine
   * how much of each message to fetch. Since POP3 only lets us
   * download a certain number of _lines_ from the message, Pop3Client
   * selects an appropriate snippet size (say, 4KB) and attempts to
   * fetch approximately that much data for each message. That value
   * is/should be high enough that we get snippets for nearly all
   * messages, unless a message is particularly strange.
   *
   * Additionally, we don't delete messages from the server. This
   * means that when we attempt to list messages, we'll see new
   * messages along with messages we've seen before. To ensure we only
   * retrieve messages we don't know about, we keep track of message
   * unique IDs (UIDLs) and only download new messages.
   */
  sync: lazyWithConnection(/* getNew = */ true, /* cbIndex = */ 2,
  function(conn, initialSync, slice, doneCallback, progressCallback) {
    // if we could not establish a connection, abort the sync.
    var self = this;
    this._LOG.sync_begin();

    // Only fetch info for messages we don't already know about.
    var filterFunc = function(uidl) {
      return self.getMessageIdForUidl(uidl) == null; // might be 0
    };

    var bytesStored = 0;
    var numMessagesSynced = 0;
    var latch = allback.latch();

    if (!this.isInbox) {
      slice.desiredHeaders = (this._TEST_pendingAdds &&
                              this._TEST_pendingAdds.length);
      this._performTestDeletions(latch.defer());
    } else {
      var fetchDoneCb = latch.defer();
      // Fetch messages, ensuring that we don't actually store them all in
      // memory so as not to burden memory unnecessarily.
      conn.listMessages(
        filterFunc,
        function fetchProgress(evt) {
          // Store each message as it is retrieved.
          var totalBytes = evt.totalBytes;
          var message = evt.message;
          var messageCb = latch.defer();

          this.storeMessage(message.header, message.bodyInfo, function() {
            bytesStored += evt.size;
            numMessagesSynced++;
            progressCallback(0.1 + 0.7 * bytesStored / totalBytes);
            messageCb();
          });
        }.bind(this),
        function fetchDone(err, numSynced) {
          // Upon downloading all of the messages, we MUST issue a QUIT
          // command. This will tear down the connection, however if we
          // don't, we will never receive notifications of new messages.
          // If we deleted any messages on the server (which we don't),
          // the QUIT command is what would actually cause those to be
          // persisted. In the future, when we support server-side
          // deletion, we should ensure that this QUIT does not
          // inadvertently commit unintended deletions.
          conn.quit();

          if (err) {
            doneCallback(err);
            return;
          }
          // When all of the messages have been persisted to disk, indicate
          // that we've successfully synced. Refresh our view of the world.
          this.storage.runAfterDeferredCalls(fetchDoneCb);
        }.bind(this));
    }

    latch.then((function onSyncDone() {
      this._LOG.sync_end();
      // POP3 always syncs the entire time range available.
      this.storage.markSyncRange(
        sync.OLDEST_SYNC_DATE, date.NOW(), 'XXX', date.NOW());
      this.storage.markSyncedToDawnOfTime();
      this.account.__checkpointSyncCompleted();
      if (initialSync) {
        // If it's the first time we've synced, we've set
        // ignoreHeaders to true, which means that slices don't know
        // about new messages. We'll reset ignoreHeaders to false
        // here, and then instruct the database to load messages
        // again.
        //
        // We're waiting for the database to settle. Since POP3
        // doesn't guarantee message ordering (in terms of listing
        // messages in your maildrop), if we just blindly updated the
        // current slice, the UI might frantically update as new
        // messages come in. So for the initial sync, just batch them
        // all in.
        this.storage._curSyncSlice.ignoreHeaders = false;
        this.storage._curSyncSlice.waitingOnData = 'db';
        this.storage.getMessagesInImapDateRange(
          0, null, sync.INITIAL_FILL_SIZE, sync.INITIAL_FILL_SIZE,
          // Don't trigger a refresh; we just synced. Accordingly,
          // releaseMutex can be null.
          this.storage.onFetchDBHeaders.bind(
            this.storage, this.storage._curSyncSlice,
            false, doneCallback, null));
      } else {
        doneCallback(null, null);
      }
    }).bind(this));

  }),
};

/** Return an array with the integers [0, end). */
function range(end) {
  var ret = [];
  for (var i = 0; i < end; i++) {
    ret.push(i);
  }
  return ret;
}

var LOGFAB = exports.LOGFAB = log.register(module, {
  Pop3FolderSyncer: {
    type: log.CONNECTION,
    subtype: log.CLIENT,
    events: {
      savedAttachment: { storage: true, mimeType: true, size: true },
      saveFailure: { storage: false, mimeType: false, error: false },
    },
    TEST_ONLY_events: {
    },
    errors: {
      callbackErr: { ex: log.EXCEPTION },

      htmlParseError: { ex: log.EXCEPTION },
      htmlSnippetError: { ex: log.EXCEPTION },
      textChewError: { ex: log.EXCEPTION },
      textSnippetError: { ex: log.EXCEPTION },

      // Attempted to sync with an empty or inverted range.
      illegalSync: { startTS: false, endTS: false },
    },
    asyncJobs: {
      sync: {},
      syncDateRange: {
        newMessages: true, existingMessages: true, deletedMessages: true,
        start: false, end: false, skewedStart: false, skewedEnd: false,
      },
    },
  },
}); // end LOGFAB

}); // end define

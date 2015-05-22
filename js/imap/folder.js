define(
  [
    'rdcommon/log',
    '../a64',
    '../allback',
    '../date',
    '../syncbase',
    '../util',
    '../slog',
    'module',
    'require',
    'exports'
  ],
  function(
    $log,
    $a64,
    $allback,
    $date,
    $sync,
    $util,
    slog,
    $module,
    require,
    exports
  ) {

/**
 * Lazily evaluated modules
 */
var $imaptextparser = null;
var $imapsnippetparser = null;
var $imapbodyfetcher = null;
var $imapchew = null;
var $imapsync = null;

var allbackMaker = $allback.allbackMaker,
    bsearchForInsert = $util.bsearchForInsert,
    bsearchMaybeExists = $util.bsearchMaybeExists,
    cmpHeaderYoungToOld = $util.cmpHeaderYoungToOld,
    DAY_MILLIS = $date.DAY_MILLIS,
    NOW = $date.NOW,
    BEFORE = $date.BEFORE,
    ON_OR_BEFORE = $date.ON_OR_BEFORE,
    SINCE = $date.SINCE,
    TIME_DIR_AT_OR_BEYOND = $date.TIME_DIR_AT_OR_BEYOND,
    TIME_DIR_ADD = $date.TIME_DIR_ADD,
    TIME_DIR_DELTA = $date.TIME_DIR_DELTA,
    makeDaysAgo = $date.makeDaysAgo,
    makeDaysBefore = $date.makeDaysBefore,
    quantizeDate = $date.quantizeDate,
    PASTWARDS = 1, FUTUREWARDS = -1;

/**
 * Compact an array in-place with nulls so that the nulls are removed.  This
 * is done by a scan with an adjustment delta and a final splice to remove
 * the spares.
 */
function compactArray(arr) {
  // this could also be done with a write pointer.
  var delta = 0, len = arr.length;
  for (var i = 0; i < len; i++) {
    var obj = arr[i];
    if (obj === null) {
      delta++;
      continue;
    }
    if (delta)
      arr[i - delta] = obj;
  }
  if (delta)
    arr.splice(len - delta, delta);
  return arr;
}

/**
 * Number of bytes to fetch from the server for snippets.
 */
var NUMBER_OF_SNIPPET_BYTES = 256;

/**
 * Maximum bytes to request from server in a fetch request (max uint32)
 */
var MAX_FETCH_BYTES = (Math.pow(2, 32) - 1);

/**
 * Folder connections do the actual synchronization logic.  They are associated
 * with one or more `ImapSlice` instances that issue the requests that trigger
 * synchronization.  Storage is handled by `FolderStorage` instances.  All of
 * the connection life-cycle nitty-gritty is handled by the `ImapAccount`.
 *
 * == Progress
 *
 * Our progress break-down is:
 * - [0.0, 0.1]: Getting the IMAP connection.
 * - (0.1, 0.25]: Getting usable SEARCH results.  Bisect back-off does not
 *     update progress.
 * - (0.25, 1.0]: Fetching revised flags, headers, and bodies.  Since this
 *     is primarily a question of network latency, we weight things based
 *     on round-trip requests required with reduced cost for number of packets
 *     required.
 *   - Revised flags: 20 + 1 * number of known headers
 *   - New headers: 20 + 5 * number of new headers
 *   - Bodies: 30 * number of new headers
 *
 * == IDLE
 *
 * We plan to IDLE in folders that we have active slices in.  We are assuming
 * the most basic IDLE implementation where it will tell us when the number
 * of messages increases (EXISTS), or decreases (EXPUNGE and EXISTS), with no
 * notifications when flags change.  (This is my current understanding of how
 * gmail operates from internet searches; we're not quite yet to protocol
 * experimentation yet.)
 *
 * The idea is accordingly that we will use IDLE notifications as a hint that
 * we should do a SEARCH for new messages.  It is that search that will update
 * our accuracy information and only that.
 */
function ImapFolderConn(account, storage, _parentLog) {
  this._account = account;
  this._storage = storage;
  this._LOG = LOGFAB.ImapFolderConn(this, _parentLog, storage.folderId);

  this._conn = null;
  this.box = null;

  this._deathback = null;
}
ImapFolderConn.prototype = {
  /**
   * Acquire a connection and invoke the callback once we have it and we have
   * entered the folder.  This method should only be called when running
   * inside `runMutexed`.
   *
   * @args[
   *   @param[callback @func[
   *     @args[
   *       @param[folderConn ImapFolderConn]
   *       @param[storage FolderStorage]
   *     ]
   *   ]]
   *   @param[deathback Function]{
   *     Invoked if the connection dies.
   *   }
   *   @param[label String]{
   *     A debugging label to name the purpose of the connection.
   *   }
   *   @param[dieOnConnectFailure #:optional Boolean]{
   *     See `ImapAccount.__folderDemandsConnection`.
   *   }
   * ]
   */
  acquireConn: function(callback, deathback, label, dieOnConnectFailure) {
    var self = this;
    this._deathback = deathback;
    this._account.__folderDemandsConnection(
      this._storage.folderId, label,
      function gotconn(conn) {
        self._conn = conn;
        // Now we have a connection, but it's not in the folder.
        // (If we were doing fancier sync like QRESYNC, we would not enter
        // in such a blase fashion.)
        self._conn.selectMailbox(self._storage.folderMeta.path,
                           function openedBox(err, box) {
            if (err) {
              console.error('Problem entering folder',
                            self._storage.folderMeta.path);
              self._conn = null;
              // hand the connection back, noting a resource problem
              self._account.__folderDoneWithConnection(
                self._conn, false, true);
              if (self._deathback) {
                var deathback = self._deathback;
                self.clearErrorHandler();
                deathback();
              }
              return;
            }
            self.box = box;
            callback(self, self._storage);
          });
      },
      function deadconn() {
        self._conn = null;
        if (self._deathback) {
          var deathback = self._deathback;
          self.clearErrorHandler();
          deathback();
        }
      },
      dieOnConnectFailure);
  },

  relinquishConn: function() {
    if (!this._conn)
      return;

    this.clearErrorHandler();
    this._account.__folderDoneWithConnection(this._conn, true, false);
    this._conn = null;
  },

  /**
   * If no connection, acquires one and also sets up
   * deathback if connection is lost.
   *
   * See `acquireConn` for argument docs.
   */
  withConnection: function (callback, deathback, label, dieOnConnectFailure) {
    if (!this._conn) {
      this.acquireConn(function () {
        this.withConnection(callback, deathback, label);
      }.bind(this), deathback, label, dieOnConnectFailure);
      return;
    }

    this._deathback = deathback;
    callback(this);
  },

  /**
   * Resets error handling that may be triggered during
   * loss of connection.
   */
  clearErrorHandler: function () {
    this._deathback = null;
  },

  reselectBox: function(callback) {
    this._conn.selectMailbox(this._storage.folderMeta.path, callback);
  },

  /**
   * Downloads all the body representations for a given message.
   *
   *
   *    folder.downloadBodyReps(
   *      header,
   *      {
   *        // maximum number of bytes to fetch total (across all bodyReps)
   *        maximumBytesToFetch: N
   *      }
   *      callback
   *    );
   *
   */
  downloadBodyReps: function() {
    var args = Array.slice(arguments);
    var self = this;

    require(
      [
        './imapchew',
        './protocol/bodyfetcher',
        './protocol/textparser',
        './protocol/snippetparser'
      ],
      function(
        _imapchew,
        _bodyfetcher,
        _textparser,
        _snippetparser
      ) {

        $imapchew =_imapchew;
        $imapbodyfetcher = _bodyfetcher;
        $imaptextparser = _textparser;
        $imapsnippetparser = _snippetparser;

        (self.downloadBodyReps = self._lazyDownloadBodyReps).apply(self, args);
    });
  },

  /**
   * Initiates a request to download all body reps for a single message. If a
   * snippet has not yet been generated this will also generate the snippet...
   */
  _lazyDownloadBodyReps: function(header, options, callback) {
    if (typeof(options) === 'function') {
      callback = options;
      options = null;
    }

    options = options || {};

    var self = this;

    var gotBody = function gotBody(bodyInfo) {
      // target for snippet generation
      var bodyRepIdx = $imapchew.selectSnippetBodyRep(header, bodyInfo);

      // assume user always wants entire email unless option is given...
      var overallMaximumBytes = options.maximumBytesToFetch;

      var bodyParser = $imaptextparser.TextParser;

      // build the list of requests based on downloading required.
      var requests = [];
      var latch = $allback.latch();
      bodyInfo.bodyReps.forEach(function(rep, idx) {
        // attempt to be idempotent by only requesting the bytes we need if we
        // actually need them...
        if (rep.isDownloaded)
          return;

        // default to the entire remaining email. We use the estimate * largish
        // multiplier so even if the size estimate is wrong we should fetch more
        // then the requested number of bytes which if truncated indicates the
        // end of the bodies content.
        var bytesToFetch = Math.min(rep.sizeEstimate * 5, MAX_FETCH_BYTES);

        if (overallMaximumBytes !== undefined) {
          // when we fetch partial results we need to use the snippet parser.
          bodyParser = $imapsnippetparser.SnippetParser;

          // issued enough downloads
          if (overallMaximumBytes <= 0) {
            return;
          }

          // if our estimate is greater then expected number of bytes
          // request the maximum allowed.
          if (rep.sizeEstimate > overallMaximumBytes) {
            bytesToFetch = overallMaximumBytes;
          }

          // subtract the estimated byte size
          overallMaximumBytes -= rep.sizeEstimate;
        }

        // For a byte-serve request, we need to request at least 1 byte, so
        // request some bytes.  This is a logic simplification that should not
        // need to be used because imapchew.js should declare 0-byte files
        // fully downloaded when their parts are created, but better a wasteful
        // network request than breaking here.
        if (bytesToFetch <= 0)
          bytesToFetch = 64;

        // CONDITIONAL LOGIC BARRIER CONDITIONAL LOGIC BARRIER DITTO DITTO
        // Do not do return/continue after this point because we call
        // latch.defer below, and we break if we call it and then throw away
        // that callback without calling it.  (Unsurprisingly.)

        var request = {
          uid: header.srvid,
          partInfo: rep._partInfo,
          bodyRepIndex: idx,
          createSnippet: idx === bodyRepIdx,
          headerUpdatedCallback: latch.defer(header.srvid + '-' + rep._partInfo)
        };

        // we may only need a subset of the total number of bytes.
        if (overallMaximumBytes !== undefined || rep.amountDownloaded) {
          // request the remainder
          request.bytes = [
            rep.amountDownloaded,
            bytesToFetch
          ];
        }

        requests.push(request);
      });

      // we may not have any requests bail early if so.
      if (!requests.length) {
        callback(null, bodyInfo); // no requests === success
        return;
      }

      var fetch = new $imapbodyfetcher.BodyFetcher(
        self._conn,
        bodyParser,
        requests
      );

      self._handleBodyFetcher(fetch, header, bodyInfo, latch.defer('body'));
      latch.then(function(results) {
        callback($allback.extractErrFromCallbackArgs(results), bodyInfo);
      });
    };

    this._storage.getMessageBody(header.suid, header.date, gotBody);
  },

  /**
   * Wrapper around common bodyRep updates...
   */
  _handleBodyFetcher: function(fetcher, header, body, bodyUpdatedCallback) {
    var event = {
      changeDetails: {
        bodyReps: []
      }
    };

    // This will be invoked once per body part that is successfully downloaded
    // or fails to download.
    fetcher.onparsed = function(err, req, resp) {
      if (err) {
        req.headerUpdatedCallback(err);
        return;
      }

      $imapchew.updateMessageWithFetch(header, body, req, resp, this._LOG);

      header.bytesToDownloadForBodyDisplay =
        $imapchew.calculateBytesToDownloadForImapBodyDisplay(body);

      // Always update the header so that we can save
      // bytesToDownloadForBodyDisplay, which will tell the UI whether
      // or not we can show the message body right away.
      this._storage.updateMessageHeader(
        header.date,
        header.id,
        false,
        header,
        body,
        req.headerUpdatedCallback.bind(null, null) // no error
      );

      event.changeDetails.bodyReps.push(req.bodyRepIndex);
    }.bind(this);

    // This will be invoked after all of the onparsed events have fired.
    fetcher.onend = function() {
      // Since we no longer have any updates to make to the body, we want to
      // finally update it now.
      this._storage.updateMessageBody(
        header,
        body,
        {},
        event,
        bodyUpdatedCallback.bind(null, null) // we do not/cannot error
      );
    }.bind(this);
  },

  /**
   * The actual work of downloadBodies, lazily replaces downloadBodies once
   * module deps are loaded.
   */
  _lazyDownloadBodies: function(headers, options, callback) {
    var downloadsNeeded = 0;
    var latch = $allback.latch();
    for (var i = 0; i < headers.length; i++) {
      // We obviously can't do anything with null header references.
      // To avoid redundant work, we also don't want to do any fetching if we
      // already have a snippet.  This could happen because of the extreme
      // potential for a caller to spam multiple requests at us before we
      // service any of them.  (Callers should only have one or two outstanding
      // jobs of this and do their own suppression tracking, but bugs happen.)
      var header = headers[i];
      if (!header || header.snippet !== null) {
        continue;
      }

      // This isn't absolutely guaranteed to be 100% correct, but is good enough
      // for indicating to the caller that we did some work.
      downloadsNeeded++;
      this.downloadBodyReps(headers[i], options, latch.defer(header.suid));
    }
    latch.then(function(results) {
      callback($allback.extractErrFromCallbackArgs(results), downloadsNeeded);
    });
  },

  /**
   * Download snippets or entire bodies for a set of headers.
   */
  downloadBodies: function() {
    var args = Array.slice(arguments);
    var self = this;

    require(
      ['./imapchew', './protocol/bodyfetcher', './protocol/snippetparser'],
      function(
        _imapchew,
        _bodyfetcher,
        _snippetparser
      ) {

        $imapchew =_imapchew;
        $imapbodyfetcher = _bodyfetcher;
        $imapsnippetparser = _snippetparser;

        (self.downloadBodies = self._lazyDownloadBodies).apply(self, args);
    });
  },

  downloadMessageAttachments: function(uid, partInfos, callback, progress) {
    require(['mimeparser'], function(MimeParser) {
      var conn = this._conn;
      var self = this;

      var latch = $allback.latch();
      var anyError = null;
      var bodies = [];

      partInfos.forEach(function(partInfo, index) {
        var partKey = 'body.peek[' + partInfo.part + ']';
        var partDone = latch.defer(partInfo.part);
        conn.listMessages(
          uid,
          [partKey],
          { byUid: true },
          function(err, messages) {
            if (err) {
              anyError = err;
              console.error('attachments:download-error', {
                error: err,
                part: partInfo.part,
                type: partInfo.type
              });
              partDone();
              return;
            }

            // We only receive one message per each listMessages call.
            var msg = messages[0];

            // Find the proper response key of the message. Since this
            // response object is a lightweight wrapper around the
            // response returned from the IRC server and it's possible
            // there are poorly-behaved servers out there, best to err
            // on the side of safety.
            var bodyPart;
            for (var key in msg) {
              if (/body\[/.test(key)) {
                bodyPart = msg[key];
                break;
              }
            }

            if (!bodyPart) {
              console.error('attachments:download-error', {
                error: 'no body part?',
                requestedPart: partKey,
                responseKeys: Object.keys(msg)
              });
              partDone();
              return;
            }

            // TODO: stream attachments, bug 1047032
            var parser = new MimeParser();
            // TODO: escape partInfo.type/encoding
            parser.write('Content-Type: ' + partInfo.type + '\r\n');
            parser.write('Content-Transfer-Encoding: ' + partInfo.encoding + '\r\n');
            parser.write('\r\n');
            parser.write(bodyPart);
            parser.end(); // Parsing is actually synchronous.

            var node = parser.node;

            bodies[index] = new Blob([node.content], {
              type: node.contentType.value
            });

            partDone();
          });
      });

      latch.then(function(results) {
        callback(anyError, bodies);
      });
    }.bind(this));
  },

  shutdown: function() {
    this._LOG.__die();
  },
};

function ImapFolderSyncer(account, folderStorage, _parentLog) {
  this._account = account;
  this.folderStorage = folderStorage;

  this._LOG = LOGFAB.ImapFolderSyncer(this, _parentLog, folderStorage.folderId);


  this.folderConn = new ImapFolderConn(account, folderStorage, this._LOG);
}
exports.ImapFolderSyncer = ImapFolderSyncer;
ImapFolderSyncer.prototype = {
  /**
   * Although we do have some errbackoff stuff we do, we can always try to
   * synchronize.  The errbackoff is just a question of when we will retry.
   */
  syncable: true,

  /**
   * Can we grow this sync range?  IMAP always lets us do this.
   */
  get canGrowSync() {
    // Some folders, like localdrafts and outbox, cannot be synced
    // because they are local-only.
    return !this.folderStorage.isLocalOnly;
  },

  /**
   * Invoked when there are no longer any live slices on the folder and no more
   * active/enqueued mutex ops.
   */
  allConsumersDead: function() {
    this.folderConn.relinquishConn();
  },

  shutdown: function() {
    this.folderConn.shutdown();
    this._LOG.__die();
  },
};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  ImapFolderConn: {
    type: $log.CONNECTION,
    subtype: $log.CLIENT,
    events: {
    },
    TEST_ONLY_events: {
    },
    errors: {
      callbackErr: { ex: $log.EXCEPTION },

      htmlParseError: { ex: $log.EXCEPTION },
      htmlSnippetError: { ex: $log.EXCEPTION },
      textChewError: { ex: $log.EXCEPTION },
      textSnippetError: { ex: $log.EXCEPTION },

      // Attempted to sync with an empty or inverted range.
      illegalSync: { startTS: false, endTS: false },
    },
    asyncJobs: {
      syncDateRange: {
        newMessages: true, existingMessages: true, deletedMessages: true,
        start: false, end: false,
      },
    },
  },
  ImapFolderSyncer: {
    type: $log.DATABASE,
    events: {
    }
  },
}); // end LOGFAB

}); // end define

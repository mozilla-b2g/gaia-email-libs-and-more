define(
  [
    'rdcommon/log',
    '../a64',
    '../allback',
    '../date',
    '../syncbase',
    '../util',
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
 * We don't care about deleted messages, it's best that we're not aware of them.
 * However, it's important to keep in mind that this means that EXISTS provides
 * us with an upper bound on the messages in the folder since we are blinding
 * ourselves to deleted messages.
 */
var BASELINE_SEARCH_OPTIONS = ['!DELETED'];

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
        self._conn.openBox(self._storage.folderMeta.path,
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
   */
  withConnection: function (callback, deathback, label) {
    if (!this._conn) {
      this.acquireConn(function () {
        this.withConnection(callback, deathback, label);
      }.bind(this), deathback, label);
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
    this._conn.openBox(this._storage.folderMeta.path, callback);
  },

  /**
   * Perform a SEARCH for the purposes of folder synchronization.  In the event
   * we are unable to reach the server (we are offline, the server is down,
   * nework troubles), the `abortedCallback` will be invoked.  Note that it can
   * take many seconds for us to conclusively fail to reach the server.
   */
  _timelySyncSearch: function(searchOptions, searchedCallback,
                              abortedCallback, progressCallback) {
    // If we don't have a connection, get one, then re-call.
    if (!this._conn) {
      // XXX the abortedCallback should really only be used for the duration
      // of this request, but it will end up being used for the entire duration
      // our folder holds on to the connection.  This is not a great idea as
      // long as we are leaving the IMAP connection idling in the folder (which
      // causes us to not release the connection back to the account).  We
      // should tie this to the mutex or something else transactional.
      this.acquireConn(
        this._timelySyncSearch.bind(this, searchOptions, searchedCallback,
                                    abortedCallback, progressCallback),
        abortedCallback, 'sync', true);
      return;
    }
    // We do have a connection, hook-up our abortedCallback
    else {
      this._deathback = abortedCallback;
    }

    // Having a connection is 10% of the battle
    if (progressCallback)
      progressCallback(0.1);
    this._conn.search(searchOptions, function(err, uids) {
        if (err) {
          console.error('Search error on', searchOptions, 'err:', err);
          abortedCallback();
          return;
        }
        searchedCallback(uids);
      });
  },

  syncDateRange: function() {
    var args = Array.slice(arguments);
    var self = this;

    require(['./protocol/sync'], function(_sync) {
      $imapsync = _sync;
      (self.syncDateRange = self._lazySyncDateRange).apply(self, args);
    });
  },

  /**
   * Perform a search to find all the messages in the given date range.
   * Meanwhile, load the set of messages from storage.  Infer deletion of the
   * messages we already know about that should exist in the search results but
   * do not.  Retrieve information on the messages we don't know anything about
   * and update the metadata on the messages we do know about.
   *
   * An alternate way to accomplish the new/modified/deleted detection for a
   * range might be to do a search over the UID range of new-to-us UIDs and
   * then perform retrieval on what we get back.  We would do a flag fetch for
   * all the UIDs we already know about and use that to both get updated
   * flags and infer deletions from UIDs that don't report back.  Except that
   * might not work because the standard doesn't seem to say that if we
   * specify gibberish UIDs that it should keep going for the UIDs that are
   * not gibberish.  Also, it's not clear what the performance impact of the
   * additional search constraint might be on server performance.  (Of course,
   * if the server does not have an index on internaldate, these queries are
   * going to be very expensive and the UID limitation would probably be a
   * mercy to the server.)
   *
   * @args[
   *   @param[startTS @oneof[null DateMS]]{
   *     If non-null, inclusive "SINCE" constraint to use, otherwise the
   *     constraint is omitted.
   *   }
   *   @param[endTS @oneof[null DateMS]]{
   *     If non-null, exclusive "BEFORE" constraint to use, otherwise the
   *     constraint is omitted.
   *   }
   * ]
   */
  _lazySyncDateRange: function(startTS, endTS, accuracyStamp,
                          doneCallback, progressCallback) {
    if (startTS && endTS && SINCE(startTS, endTS)) {
      this._LOG.illegalSync(startTS, endTS);
      doneCallback('invariant');
      return;
    }

console.log("syncDateRange:", startTS, endTS);
    var searchOptions = BASELINE_SEARCH_OPTIONS.concat(), self = this,
      storage = self._storage;
    var useBisectLimit = $sync.BISECT_DATE_AT_N_MESSAGES;
    if (startTS)
      searchOptions.push(['SINCE', startTS]);
    if (endTS)
      searchOptions.push(['BEFORE', endTS]);

    var callbacks = allbackMaker(
      ['search', 'db'],
      function syncDateRangeLogic(results) {
        var serverUIDs = results.search, headers = results.db,
            knownUIDs = [], uid, numDeleted = 0,
            modseq = self._conn._state.box.highestModSeq || '';

console.log('SERVER UIDS', serverUIDs.length, useBisectLimit);
        if (serverUIDs.length > useBisectLimit) {
          var effEndTS = endTS ||
                         quantizeDate(NOW() + DAY_MILLIS + self._account.tzOffset),
              curDaysDelta = Math.round((effEndTS - startTS) / DAY_MILLIS);
          // We are searching more than one day, we can shrink our search.

console.log('BISECT CASE', serverUIDs.length, 'curDaysDelta', curDaysDelta);
          if (curDaysDelta > 1) {
            // mark the bisection abort...
            self._LOG.syncDateRange_end(null, null, null, startTS, endTS,
                                        null, null);
            var bisectInfo = {
              oldStartTS: startTS,
              oldEndTS: endTS,
              numHeaders: serverUIDs.length,
              curDaysDelta: curDaysDelta,
              newStartTS: startTS,
              newEndTS: endTS,
            };
            // If we were being used for a refresh, they may want us to stop
            // and change their sync strategy.
            if (doneCallback('bisect', bisectInfo, null) === 'abort') {
              self.clearErrorHandler();
              doneCallback('bisect-aborted', null);
              return null;
            }
            return self.syncDateRange(
              bisectInfo.newStartTS, bisectInfo.newEndTS, accuracyStamp,
              doneCallback, progressCallback);
          }
        }

        if (progressCallback)
          progressCallback(0.25);

        // -- infer deletion, flag to distinguish known messages
        // rather than splicing lists and causing shifts, we null out values.
        for (var iMsg = 0; iMsg < headers.length; iMsg++) {
          var header = headers[iMsg];
          var idxUid = serverUIDs.indexOf(header.srvid);
          // deleted!
          if (idxUid === -1) {
            storage.deleteMessageHeaderAndBodyUsingHeader(header);
            numDeleted++;
            headers[iMsg] = null;
            continue;
          }
          // null out the UID so the non-null values in the search are the
          // new messages to us.
          serverUIDs[idxUid] = null;
          // but save the UID so we can do a flag-check.
          knownUIDs.push(header.srvid);
        }

        var newUIDs = compactArray(serverUIDs); // (re-labeling, same array)
        if (numDeleted)
          compactArray(headers);

        var uidSync = new $imapsync.Sync({
          connection: self._conn,
          storage: self._storage,
          newUIDs: newUIDs,
          knownUIDs: knownUIDs,
          knownHeaders: headers
        });

        uidSync.onprogress = progressCallback;

        uidSync.oncomplete = function(newCount, knownCount) {
            self._LOG.syncDateRange_end(newCount, knownCount, numDeleted,
                                        startTS, endTS, null, null);

            self._storage.markSyncRange(startTS, endTS, modseq,
                                        accuracyStamp);
            if (completed)
              return;

            completed = true;
            self.clearErrorHandler();
            doneCallback(null, null, newCount + knownCount,
                         skewedStartTS, skewedEndTS);
        };

        return;
      });

    // - Adjust DB time range for server skew on INTERNALDATE
    // See https://github.com/mozilla-b2g/gaia-email-libs-and-more/issues/12
    // for more in-depth details.  The nutshell is that the server will secretly
    // apply a timezone to the question we ask it and will not actually tell us
    // dates lined up with UTC.  Accordingly, we don't want our DB query to
    // be lined up with UTC but instead the time zone.
    //
    // So if our timezone offset is UTC-4, that means that we will actually be
    // getting results in that timezone, whose midnight is actually 4am UTC.
    // In other words, we care about the time in UTC-0, so we subtract the
    // offset.
    var skewedStartTS = startTS - this._account.tzOffset,
        skewedEndTS = endTS ? endTS - this._account.tzOffset : null,
        completed = false;
    console.log('Skewed DB lookup. Start: ',
                skewedStartTS, new Date(skewedStartTS).toUTCString(),
                'End: ', skewedEndTS,
                skewedEndTS ? new Date(skewedEndTS).toUTCString() : null);
    this._LOG.syncDateRange_begin(null, null, null, startTS, endTS,
                                  skewedStartTS, skewedEndTS);
    this._timelySyncSearch(
      searchOptions, callbacks.search,
      function abortedSearch() {
        if (completed)
          return;
        completed = true;
        this._LOG.syncDateRange_end(0, 0, 0, startTS, endTS, null, null);
        doneCallback('aborted');
      }.bind(this),
      progressCallback);
    this._storage.getAllMessagesInImapDateRange(skewedStartTS, skewedEndTS,
                                                callbacks.db);
  },

  searchDateRange: function(endTS, startTS, searchParams,
                            slice) {
    var searchOptions = BASELINE_SEARCH_OPTIONS.concat(searchParams);
    if (startTS)
      searchOptions.push(['SINCE', startTS]);
    if (endTS)
      searchOptions.push(['BEFORE', endTS]);
  },

  downloadBodyReps: function() {
    var args = Array.slice(arguments);
    var self = this;

    require(
      ['./imapchew', './protocol/bodyfetcher', './protocol/textparser'],
      function(
        _imapchew,
        _bodyfetcher,
        _textparser
      ) {

        $imapchew =_imapchew;
        $imapbodyfetcher = _bodyfetcher;
        $imaptextparser = _textparser;

        (self.downloadBodyReps = self._lazyDownloadBodyReps).apply(self, args);
    });
  },

  /**
   * Initiates a request to download all body reps. If a snippet has not yet
   * been generated this will also generate the snippet...
   */
  _lazyDownloadBodyReps: function(suid, date, callback) {
    var bodyInfo;
    var header;

    var requests = [];
    var self = this;

    var gotHeader = function gotHeader(_header) {
      // header may have been deleted by the time we get here...
      if (!_header) {
        return callback();
      }

      header = _header;
      self._storage.getMessageBody(suid, date, gotBody);
    };

    var gotBody = function gotBody(bodyInfo) {
      if (!bodyInfo)
        return callback();

      // target for snippet generation
      var bodyRepIdx = $imapchew.selectSnippetBodyRep(header, bodyInfo);

      // build the list of requests based on downloading required.
      bodyInfo.bodyReps.forEach(function(rep, idx) {

        // attempt to be idempotent by only requesting the bytes we need if we
        // actually need them...
        if (rep.isDownloaded)
          return;

        var request = {
          uid: header.srvid,
          partInfo: rep._partInfo,
          bodyRepIndex: idx,
          createSnippet: idx === bodyRepIdx
        };

        // we may only need a subset of the total number of bytes.
        if (rep.amountDownloaded) {
          // request the remainder
          request.bytes = [
            rep.amountDownloaded,
            Math.min(rep.sizeEstimate * 5, MAX_FETCH_BYTES)
          ];
        }

        requests.push(request);
      });

      // we may not have any requests bail early if so.
      if (!requests.length)
        callback(); // no requests === success

      var fetch = new $imapbodyfetcher.BodyFetcher(
        self._conn,
        $imaptextparser.TextParser,
        requests
      );

      self._handleBodyFetcher(fetch, header, bodyInfo, function(err) {
        callback(err, bodyInfo);
      });
    };

    self._storage.getMessageHeader(suid, date, gotHeader);
  },

  /**
   * Download a snippet and a portion of the bodyRep to go along with it... In
   * all cases we expect the bodyReps to be completely empty as we also will
   * generate the snippet in the case of completely downloading a snippet.
   */
  _downloadSnippet: function(header, callback) {
    var self = this;
    this._storage.getMessageBody(header.suid, header.date, function(body) {
      // attempt to find a rep
      var bodyRepIndex = $imapchew.selectSnippetBodyRep(header, body);

      // no suitable snippet we are done.
      if (bodyRepIndex === -1)
        return callback();

      var rep = body.bodyReps[bodyRepIndex];
      var requests = [{
        uid: header.srvid,
        bodyRepIndex: bodyRepIndex,
        partInfo: rep._partInfo,
        bytes: [0, NUMBER_OF_SNIPPET_BYTES],
        createSnippet: true
      }];

      var fetch = new $imapbodyfetcher.BodyFetcher(
        self._conn,
        $imapsnippetparser.SnippetParser,
        requests
      );

      self._handleBodyFetcher(
        fetch,
        header,
        body,
        callback
      );
    });
  },

  /**
   * Wrapper around common bodyRep updates...
   */
  _handleBodyFetcher: function(fetcher, header, body, callback) {
    var event = {
      changeType: 'bodyReps',
      indexes: []
    };

    var self = this;

    fetcher.onparsed = function(req, resp) {
      $imapchew.updateMessageWithFetch(header, body, req, resp, self._LOG);

      if (req.createSnippet) {
        self._storage.updateMessageHeader(
          header.date,
          header.id,
          false,
          header
        );
      }

      event.indexes.push(req.bodyRepIndex);
    };

    fetcher.onerror = function(e) {
      callback(e);
    };

    fetcher.onend = function() {
      self._storage.updateMessageBody(
        header,
        body,
        event
      );

      self._storage.runAfterDeferredCalls(callback);
    };
  },

  /**
   * Download snippets for a set of headers.
   */
  _lazyDownloadSnippets: function(headers, callback) {
    var i = 0;
    var len = headers.length;
    var pending = 1;

    var self = this;
    var anyErr;
    function next(err) {
      if (err && !anyErr)
        anyErr = err;

      if (!--pending) {
        self._storage.runAfterDeferredCalls(function() {
          callback(anyErr);
        });
      }
    }

    for (; i < len; i++) {
      if (!headers[i] || headers[i].snippet) {
        continue;
      }

      pending++;
      this._downloadSnippet(headers[i], next);
    }

    // by having one pending item always this handles the case of not having any
    // snippets needing a download and also returning in the next tick of the
    // event loop.
    window.setZeroTimeout(next);
  },

  downloadSnippets: function() {
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

        (self.downloadSnippets = self._lazyDownloadSnippets).apply(self, args);
    });
  },

  downloadMessageAttachments: function(uid, partInfos, callback, progress) {
    require(['mailparser/mailparser'], function($mailparser) {
      var conn = this._conn;
      var self = this;
      var mparser = new $mailparser.MailParser();

      // I actually implemented a usable shim for the checksum purposes, but we
      // don't actually care about the checksum, so why bother doing the work?
      var dummyChecksummer = {
        update: function() {},
        digest: function() { return null; },
      };

      function setupBodyParser(partInfo) {
        mparser._state = 0x2; // body
        mparser._remainder = '';
        mparser._currentNode = null;
        mparser._currentNode = mparser._createMimeNode(null);
        mparser._currentNode.attachment = true;
        mparser._currentNode.checksum = dummyChecksummer;
        mparser._currentNode.content = undefined;
        // nb: mparser._multipartTree is an empty list (always)
        mparser._currentNode.meta.contentType = partInfo.type;
        mparser._currentNode.meta.transferEncoding = partInfo.encoding;
        mparser._currentNode.meta.charset = null; //partInfo.charset;
        mparser._currentNode.meta.textFormat = null; //partInfo.textFormat;
      }
      function bodyParseBuffer(buffer) {
        process.immediate = true;
        mparser.write(buffer);
        process.immediate = false;
      }
      function finishBodyParsing() {
        process.immediate = true;
        mparser._process(true);
        process.immediate = false;
        // this is a Buffer!
        return mparser._currentNode.content;
      }

      var anyError = null, pendingFetches = 0, bodies = [];
      partInfos.forEach(function(partInfo) {
        var opts = {
          request: {
            struct: false,
            headers: false,
            body: partInfo.part
          }
        };
        pendingFetches++;
        var fetcher = conn.fetch(uid, opts);

        setupBodyParser(partInfo);
        fetcher.on('error', function(err) {
          if (!anyError)
            anyError = err;
          if (--pendingFetches === 0) {
            try {
              callback(anyError, bodies);
            }
            catch (ex) {
              self._LOG.callbackErr(ex);
            }
          }
        });
        fetcher.on('message', function(msg) {
          setupBodyParser(partInfo);
          msg.on('data', bodyParseBuffer);
          msg.on('end', function() {
            bodies.push(new Blob([finishBodyParsing()], { type: partInfo.type }));

            if (--pendingFetches === 0) {
              try {
                callback(anyError, bodies);
              }
              catch (ex) {
                self._LOG.callbackErr(ex);
              }
            }
          });
        });
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


  this._syncSlice = null;
  /**
   * The timestamp to use for `markSyncRange` for all syncs in this higher
   * level sync.  Accuracy time-info does not need high precision, so this
   * results in fewer accuracy structures and simplifies our decision logic
   * in `sliceOpenMostRecent`.
   */
  this._curSyncAccuracyStamp = null;
  /**
   * @oneof[
   *   @case[1]{
   *     Growing older/into the past.
   *   }
   *   @case[-1]{
   *     Growing into the present/future.
   *   }
   * ]{
   *   Sync growth direction.  Numeric values chosen to be consistent with
   *   slice semantics (which are oriented like they are because the slices
   *   display messages from newest to oldest).
   * }
   */
  this._curSyncDir = 1;
  /**
   * Synchronization is either 'grow' or 'refresh'.  Growth is when we just
   * want to learn about some new messages.  Refresh is when we know we have
   * already synchronized a time region and want to fully update it and so will
   * keep going until we hit our `syncThroughTS` threshold.
   */
  this._curSyncIsGrow = null;
  /**
   * The timestamp that will anchor the next synchronization.
   */
  this._nextSyncAnchorTS = null;
  /**
   * In the event of a bisection, this is the timestamp to fall back to rather
   * than continuing from our
   */
  this._fallbackOriginTS = null;
  /**
   * The farthest timestamp that we should synchronize through.  The value
   * null is potentially meaningful if we are synchronizing FUTUREWARDS.
   */
  this._syncThroughTS = null;
  /**
   * The number of days we are looking into the past in the current sync step.
   */
  this._curSyncDayStep = null;
  /**
   * If non-null, then we must synchronize all the way through the provided date
   * before we begin increasing _curSyncDayStep.  This helps us avoid
   * oscillation where we make the window too large, shrink it, but then find
   * find nothing.  Since we know that there are going to be a lot of messages
   * before we hit this date, it makes sense to keep taking smaller sync steps.
   */
  this._curSyncDoNotGrowBoundary = null;
  /**
   * The callback to invoke when we complete the sync, regardless of success.
   */
  this._curSyncDoneCallback = null;

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
    // localdrafts is offline-only, so we can't ask the server for messages.
    return this.folderStorage.folderMeta.type !== 'localdrafts';
  },

  /**
   * Perform an initial synchronization of a folder from now into the past,
   * starting with the specified step size.
   */
  initialSync: function(slice, initialDays, syncCallback,
                        doneCallback, progressCallback) {
    syncCallback('sync', false);
    this._startSync(
      slice, PASTWARDS, // sync into the past
      'grow',
      null, // start syncing from the (unconstrained) future
      $sync.OLDEST_SYNC_DATE, // sync no further back than this constant
      null,
      initialDays,
      doneCallback, progressCallback);
  },

  /**
   * Perform a refresh synchronization covering the requested time range.  This
   * may be converted into multiple smaller synchronizations, but the completion
   * notification will only be generated once the entire time span has been
   * synchronized.
   */
  refreshSync: function(slice, dir, startTS, endTS, origStartTS,
                        doneCallback, progressCallback) {
    // timezone compensation happens in the caller
    this._startSync(
      slice, dir,
      'refresh', // this is a refresh, not a grow!
      dir === PASTWARDS ? endTS : startTS,
      dir === PASTWARDS ? startTS : endTS,
      origStartTS,
      /* syncStepDays */ null, doneCallback, progressCallback);
  },

  /**
   * Synchronize into a time period not currently covered.  Growth has an
   * explicit direction and explicit origin timestamp.
   *
   * @args[
   *   @param[slice]
   *   @param[growthDirection[
   *   @param[anchorTS]
   *   @param[syncStepDays]
   *   @param[doneCallback]
   *   @param[progressCallback]
   * ]
   * @return[Boolean]{
   *   Returns false if no sync is necessary.
   * }
   */
  growSync: function(slice, growthDirection, anchorTS, syncStepDays,
                     doneCallback, progressCallback) {
    var syncThroughTS;
    if (growthDirection === PASTWARDS) {
      syncThroughTS = $sync.OLDEST_SYNC_DATE;
    }
    else { // FUTUREWARDS
      syncThroughTS = null;
    }

    this._startSync(slice, growthDirection, 'grow',
                    anchorTS, syncThroughTS, null, syncStepDays,
                    doneCallback, progressCallback);
  },

  _startSync: function ifs__startSync(slice, dir, syncTypeStr,
                                      originTS, syncThroughTS, fallbackOriginTS,
                                      syncStepDays,
                                      doneCallback, progressCallback) {
    var startTS, endTS;
    this._syncSlice = slice;
    this._curSyncAccuracyStamp = NOW();
    this._curSyncDir = dir;
    this._curSyncIsGrow = (syncTypeStr === 'grow');
    this._fallbackOriginTS = fallbackOriginTS;
    if (dir === PASTWARDS) {
      endTS = originTS;
      if (syncStepDays) {
        if (endTS)
          this._nextSyncAnchorTS = startTS = endTS - syncStepDays * DAY_MILLIS;
        else
          this._nextSyncAnchorTS = startTS = makeDaysAgo(syncStepDays,
                                                         this._account.tzOffset);
      }
      else {
        startTS = syncThroughTS;
        this._nextSyncAnchorTS = null;
      }
    }
    else { // FUTUREWARDS
      startTS = originTS;
      if (syncStepDays) {
        this._nextSyncAnchorTS = endTS = startTS + syncStepDays * DAY_MILLIS;
      }
      else {
        endTS = syncThroughTS;
        this._nextSyncAnchorTS = null;
      }
    }
    this._syncThroughTS = syncThroughTS;
    this._curSyncDayStep = syncStepDays;
    this._curSyncDoNotGrowBoundary = null;
    this._curSyncDoneCallback = doneCallback;

    this.folderConn.syncDateRange(startTS, endTS, this._curSyncAccuracyStamp,
                                  this.onSyncCompleted.bind(this),
                                  progressCallback);
  },

  _doneSync: function ifs__doneSync(err) {
    // The desired number of headers is always a rough request value which is
    // intended to be a new thing for each request.  So we don't want extra
    // desire building up, so we set it to what we have every time.
    //
    // We don't want to affect this value in accumulating mode, however, since
    // it could result in sending more headers than actually requested over the
    // wire.
    if (!this._syncSlice._accumulating)
      this._syncSlice.desiredHeaders = this._syncSlice.headers.length;

    if (this._curSyncDoneCallback)
      this._curSyncDoneCallback(err);

    // Save our state even if there was an error because we may have accumulated
    // some partial state.
    this._account.__checkpointSyncCompleted();

    this._syncSlice = null;
    this._curSyncAccuracyStamp = null;
    this._curSyncDir = null;
    this._nextSyncAnchorTS = null;
    this._syncThroughTS = null;
    this._curSyncDayStep = null;
    this._curSyncDoNotGrowBoundary = null;
    this._curSyncDoneCallback = null;
  },

  /**
   * Whatever synchronization we last triggered has now completed; we should
   * either trigger another sync if we still want more data, or close out the
   * current sync.
   *
   * ## Block Flushing
   *
   * We only cause a call to `ImapAccount.__checkpointSyncCompleted` (via a call
   * to `_doneSync`) to happen and cause dirty blocks to be written to disk when
   * we are done with synchronization.  This is because this method declares
   * victory once a non-trivial amount of work has been done.  In the event that
   * the sync is encountering a lot of deleted messages and so keeps loading
   * blocks, the memory burden is limited because we will be emptying those
   * blocks out so actual memory usage (after GC) is commensurate with the
   * number of (still-)existing messages.  And those are what this method uses
   * to determine when it is done.
   *
   * In the cases where we are synchronizing a ton of messages on a single day,
   * we could perform checkpoints during the process, but realistically any
   * device we are operating on should probably have enough memory to deal with
   * these surges, so we're not doing that yet.
   *
   * @args[
   *   @param[err]
   *   @param[bisectInfo]
   *   @param[messagesSeen Number]
   *   @param[effStartTS DateMS]{
   *     Effective start date in UTC after compensating for server tz offset.
   *   }
   *   @param[effEndTS @oneof[DateMS null]]{
   *     Effective end date in UTC after compensating for server tz offset.
   *     If the end date was open-ended, then null is passed instead.
   *   }
   * ]
   */
  onSyncCompleted: function ifs_onSyncCompleted(err, bisectInfo, messagesSeen,
                                                effStartTS, effEndTS) {
    // In the event the time range had to be bisected, update our info so if
    // we need to take another step we do the right thing.
    if (err === 'bisect') {
      var curDaysDelta = bisectInfo.curDaysDelta,
          numHeaders = bisectInfo.numHeaders;

      // If we had a fallback TS because we were synced to the dawn of time,
      // use that and start by just cutting the range in thirds rather than
      // doing a weighted bisection since the distribution might include
      // a number of messages earlier than our fallback startTS.
      if (this._curSyncDir === FUTUREWARDS && this._fallbackOriginTS) {
        this.folderStorage.clearSyncedToDawnOfTime(this._fallbackOriginTS);
        bisectInfo.oldStartTS = this._fallbackOriginTS;
        this._fallbackOriginTS = null;
        var effOldEndTS = bisectInfo.oldEndTS ||
                          quantizeDate(NOW() + DAY_MILLIS +
                                       this._account.tzOffset);
        curDaysDelta = Math.round((effOldEndTS - bisectInfo.oldStartTS) /
                                  DAY_MILLIS);
        numHeaders = $sync.BISECT_DATE_AT_N_MESSAGES * 1.5;
      }
      // Sanity check the time delta; if we grew the bounds to the dawn
      // of time, then our interpolation is useless and it's better for
      // us to crank things way down, even if it's erroneously so.
      else if (curDaysDelta > 1000)
        curDaysDelta = 30;

      // - Interpolate better time bounds.
      // Assume a linear distribution of messages, but overestimated by
      // a factor of two so we undershoot.  Also make sure that we subtract off
      // at least 2 days at a time.  This is to ensure that in the case where
      // endTS is null and we end up using makeDaysAgo that we actually shrink
      // by at least 1 day (because of how rounding works for makeDaysAgo).
      var shrinkScale = $sync.BISECT_DATE_AT_N_MESSAGES /
                          (numHeaders * 2),
          dayStep = Math.max(1,
                             Math.min(curDaysDelta - 2,
                                      Math.ceil(shrinkScale * curDaysDelta)));
      this._curSyncDayStep = dayStep;

      if (this._curSyncDir === PASTWARDS) {
        bisectInfo.newEndTS = bisectInfo.oldEndTS;
        this._nextSyncAnchorTS = bisectInfo.newStartTS =
          makeDaysBefore(bisectInfo.newEndTS, dayStep, this._account.tzOffset);
        this._curSyncDoNotGrowBoundary = bisectInfo.oldStartTS;
      }
      else { // FUTUREWARDS
        bisectInfo.newStartTS = bisectInfo.oldStartTS;
        this._nextSyncAnchorTS = bisectInfo.newEndTS =
          makeDaysBefore(bisectInfo.newStartTS, -dayStep, this._account.tzOffset);
        this._curSyncDoNotGrowBoundary = bisectInfo.oldEndTS;
      }

      // We return now without calling _doneSync because we are not done; the
      // caller (syncDateRange) will re-trigger itself and keep going.
      return;
    }
    else if (err) {
      this._doneSync(err);
      return;
    }

    console.log("Sync Completed!", this._curSyncDayStep, "days",
                messagesSeen, "messages synced");

    // - Slice is dead = we are done
    if (this._syncSlice.isDead) {
      this._doneSync();
      return;
    }

    // If it now appears we know about all the messages in the folder, then we
    // are done syncing and can mark the entire folder as synchronized.  This
    // requires that:
    // - The direction is pastwards. (We check the oldest header, so this
    //   is important.  We don't really need to do a future-wards variant since
    //   we always use pastwards for refreshes and the future-wards variant
    //   really does not need a fast-path since the cost of stepping to 'today'
    //   is much cheaper thana the cost of walking all the way to 1990.)
    // - The number of messages we know about is the same as the number the
    //   server most recently told us are in the folder.
    // - (There are no messages in the folder at all OR)
    // - We have synchronized past the oldest known message header.  (This,
    //   in combination with the fact that we always open from the most recent
    //   set of messages we know about, that we fully synchronize all time
    //   intervals (for now!), and our pastwards-direction for refreshes means
    //   that we can conclude we have synchronized across all messages and
    //   this is a sane conclusion to draw.)
    //
    // NB: If there are any deleted messages, this logic will not save us
    // because we ignored those messages.  This is made less horrible by issuing
    // a time-date that expands as we go further back in time.
    //
    // (I have considered asking to see deleted messages too and ignoring them;
    // that might be suitable.  We could also just be a jerk and force an
    // expunge.)
    var folderMessageCount = this.folderConn && this.folderConn.box &&
                             this.folderConn.box.messages.total,
        dbCount = this.folderStorage.getKnownMessageCount(),
        syncedThrough =
          ((this._curSyncDir === PASTWARDS) ? effStartTS : effEndTS);
console.log("folder message count", folderMessageCount,
            "dbCount", dbCount,
            "syncedThrough", syncedThrough,
            "oldest known", this.folderStorage.getOldestMessageTimestamp());
    if (this._curSyncDir === PASTWARDS &&
        folderMessageCount === dbCount &&
        (!folderMessageCount ||
         TIME_DIR_AT_OR_BEYOND(this._curSyncDir, syncedThrough,
                               this.folderStorage.getOldestMessageTimestamp()))
       ) {
      // expand the accuracy range to cover everybody
      this.folderStorage.markSyncedToDawnOfTime();
      this._doneSync();
      return;
    }
    // If we've synchronized to the limits of syncing in the given direction,
    // we're done.
    if (!this._nextSyncAnchorTS ||
        TIME_DIR_AT_OR_BEYOND(this._curSyncDir, this._nextSyncAnchorTS,
                              this._syncThroughTS)) {
      this._doneSync();
      return;
    }

    // - Done if this is a grow and we don't want/need any more headers.
    if (this._curSyncIsGrow &&
        this._syncSlice.headers.length >= this._syncSlice.desiredHeaders) {
        // (limited syncs aren't allowed to expand themselves)
      console.log("SYNCDONE Enough headers retrieved.",
                  "have", this._syncSlice.headers.length,
                  "want", this._syncSlice.desiredHeaders,
                  "conn knows about", this.folderConn.box.messages.total,
                  "sync date", this._curSyncStartTS,
                  "[oldest defined as", $sync.OLDEST_SYNC_DATE, "]");
      this._doneSync();
      return;
    }
    else if (this._syncSlice._accumulating) {
      // flush the accumulated results thus far
      this._syncSlice.setStatus('synchronizing', true, true, true);
    }

    // - Increase our search window size if we aren't finding anything
    // Our goal is that if we are going backwards in time and aren't finding
    // anything, we want to keep expanding our window
    var daysToSearch, lastSyncDaysInPast;
    // If we saw messages, there is no need to increase the window size.  We
    // also should not increase the size if we explicitly shrank the window and
    // left a do-not-expand-until marker.
    if (messagesSeen || (this._curSyncDoNotGrowBoundary !== null &&
         !TIME_DIR_AT_OR_BEYOND(this._curSyncDir, this._nextSyncAnchorTS,
                                this._curSyncDoNotGrowBoundary))) {
      daysToSearch = this._curSyncDayStep;
    }
    else {
      this._curSyncDoNotGrowBoundary = null;
      // This may be a fractional value because of DST
      lastSyncDaysInPast = ((quantizeDate(NOW() + this._account.tzOffset)) -
                           this._nextSyncAnchorTS) / DAY_MILLIS;
      daysToSearch = Math.ceil(this._curSyncDayStep *
                               $sync.TIME_SCALE_FACTOR_ON_NO_MESSAGES);

      if (lastSyncDaysInPast < 180) {
        if (daysToSearch > 14)
          daysToSearch = 14;
      }
      else if (lastSyncDaysInPast < 365) {
        if (daysToSearch > 30)
          daysToSearch = 30;
      }
      else if (lastSyncDaysInPast < 730) {
        if (daysToSearch > 60)
          daysToSearch = 60;
      }
      else if (lastSyncDaysInPast < 1095) {
        if (daysToSearch > 90)
          daysToSearch = 90;
      }
      else if (lastSyncDaysInPast < 1825) { // 5 years
        if (daysToSearch > 120)
          daysToSearch = 120;
      }
      else if (lastSyncDaysInPast < 3650) {
        if (daysToSearch > 365)
          daysToSearch = 365;
      }
      else if (daysToSearch > 730) {
        daysToSearch = 730;
      }
      this._curSyncDayStep = daysToSearch;
    }

    // - Move the time range back in time more.
    var startTS, endTS;
    if (this._curSyncDir === PASTWARDS) {
      endTS = this._nextSyncAnchorTS;
      this._nextSyncAnchorTS = startTS = makeDaysBefore(endTS, daysToSearch,
                                                        this._account.tzOffset);
    }
    else { // FUTUREWARDS
      startTS = this._nextSyncAnchorTS;
      this._nextSyncAnchorTS = endTS = makeDaysBefore(startTS, -daysToSearch,
                                                      this._account.tzOffset);
    }
    this.folderConn.syncDateRange(startTS, endTS, this._curSyncAccuracyStamp,
                                  this.onSyncCompleted.bind(this));
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

/**
 * ALL SPECULATIVE RIGHT NOW.
 *
 * Like ImapFolderStorage, but with only one folder and messages named by their
 * X-GM-MSGID value rather than their UID(s).
 *
 * Deletion processing operates slightly differently than for normal IMAP
 * because a message can be removed from one of the folders we synchronize on,
 * but not all of them.  We don't want to be overly deletionary in that case,
 * so we maintain a list of folder id's that are keeping each message alive.
 */
function GmailMessageStorage() {
}
GmailMessageStorage.prototype = {
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
        start: false, end: false, skewedStart: false, skewedEnd: false,
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

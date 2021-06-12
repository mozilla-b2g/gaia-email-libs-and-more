/**
 * WARNING WARNING WARNING WARNING WARNING
 *
 * I believe this is legacy dead code that's not actually used but stuck around
 * in-tree for reference purposes.  I've modernized the code now so eslint isn't
 * angry and corrected some merge screw-ups, but it seems likely this file
 * wants to be deleted.
 **/

import logic from 'logic';
import $allback from 'shared/allback';
import { DAY_MILLIS, NOW, SINCE, quantizeDate } from 'shared/date';
import $sync from '../syncbase';

/**
 * Lazily evaluated modules
 */
var $imaptextparser = null;
var $imapsnippetparser = null;
var $imapbodyfetcher = null;
var $imapchew = null;
var $imapsync = null;

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
function ImapFolderConn(account, storage) {
  this._account = account;
  this._storage = storage;

  logic.defineScope(this, 'ImapFolderConn', {
    accountId: account.id,
    folderId: storage.folderId
  });

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
                let local_deathback = self._deathback;
                self.clearErrorHandler();
                local_deathback();
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
          let local_deathback = self._deathback;
          self.clearErrorHandler();
          local_deathback();
        }
      },
      dieOnConnectFailure);
  },

  relinquishConn: function() {
    if (!this._conn) {
      return;
    }

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
==== BASE ====
   * Perform a SEARCH for the purposes of folder synchronization.  In the event
   * we are unable to reach the server (we are offline, the server is down,
   * nework troubles), the `abortedCallback` will be invoked.  Note that it can
   * take many seconds for us to conclusively fail to reach the server.
   *
   * Track an isRetry flag to ensure we don't fall into an infinite retry loop.
   */
  _timelySyncSearch: function(searchOptions, searchedCallback,
                              abortedCallback, progressCallback, isRetry) {
    var gotSearchResponse = false;

    // If we don't have a connection, get one, then re-call.
    if (!this._conn) {
      // XXX the abortedCallback should really only be used for the duration
      // of this request, but it will end up being used for the entire duration
      // our folder holds on to the connection.  This is not a great idea as
      // long as we are leaving the IMAP connection idling in the folder (which
      // causes us to not release the connection back to the account).  We
      // should tie this to the mutex or something else transactional.
      this.acquireConn(
        this._timelySyncSearch.bind(this,
                                    searchOptions, searchedCallback,
                                    abortedCallback, progressCallback,
                                    /* isRetry: */ isRetry),
        abortedCallback, 'sync', true);
      return;
    }
    // We do have a connection. Hopefully the connection is still
    // valid and functional. However, since this connection may have
    // been hanging around a while, sending data now might trigger a
    // connection reset notification. In other words, if the
    // connection has gone stale, we want to grab a new connection and
    // retry before aborting.
    else {
      if (!isRetry) {
        var origAbortedCallback = abortedCallback;
        abortedCallback = (function() {
          // Here, we've acquired an already-connected socket. If we
          // were already connected, but failed to receive a response
          // from the server, this socket is effectively dead. In that
          // case, retry the SEARCH once again with a fresh connection,
          // if we haven't already retried the request.
          if (!gotSearchResponse) {
            console.warn('Broken connection for SEARCH. Retrying.');
            this._timelySyncSearch(searchOptions, searchedCallback,
                                   origAbortedCallback, progressCallback,
                                   /* isRetry: */ true);
          }
          // Otherwise, we received an error from this._conn.search
          // below (i.e. there was a legitimate server problem), or we
          // already retried, so we should actually give up.
          else {
            origAbortedCallback();
          }
        }.bind(this));
      }
      this._deathback = abortedCallback;
    }

    // Having a connection is 10% of the battle
    if (progressCallback) {
      progressCallback(0.1);
    }

    // Gmail IMAP servers cache search results until your connection
    // gets notified of new messages via an unsolicited server
    // response. Sending a command like NOOP is required to flush the
    // cache and force SEARCH to return new messages that have just
    // been received. Other IMAP servers don't need this as far as we know.
    // See <https://bugzilla.mozilla.org/show_bug.cgi?id=933079>.
    if (this._account.isGmail) {
      this._conn.exec('NOOP');
    }

    this._conn.search(searchOptions, { byUid: true }, function(err, uids) {
        gotSearchResponse = true;
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

    require(['imap/protocol/sync'], function(_sync) {
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
   * IMAP servers do not treat the SINCE and BEFORE options to IMAP
   * SEARCH consistently. Because we compare messages in chunks of
   * time-ranges, a message may seem like it has been deleted, when it
   * actually just fell into the adjacent range bucket (Bug 886534).
   * To correct for this, we do the following:
   *
   * 1. When we sync (whether PASTWARDS or FUTUREWARDS), we include
   *    messages from a bit before and after the range we asked the
   *    server for.

   * 2. Compare those messages to the list the server returned. For
   *    any messages which we have locally, but the server did not
   *    return:
   *
   *    a) Delete any messages which are unambiguously within our
   *       current time range.
   *
   *    b) Mark any messages we expected to see (but didn't) with an
   *       indicator saying "we asked the server for messages in this
   *       time range, but we couldn't find it". If a message was
   *       already missing, expand the range to cover the current
   *       range also, indicating that the message still wasn't found
   *       after a wider search.
   *
   *    c) Inspect the "missing range" of each message. If the range
   *       covers at least a day before and after the header's date,
   *       delete the message. The server didn't return it to us even
   *       though we checked a full day before and after the message.
   *
   *    d) If the server returns the message in a sync and we haven't
   *       deleted it yet, clear the "missing" flag and start over.
   *
   * 3. Because we always sync time ranges farther into the past to
   *    show the user new messages, the ambiguity between "deleted or
   *    just hidden" disappears as we get information from continued
   *    syncs.
   *
   * TLDR: Messages on the ends of SEARCH ranges may fall into
   *       adjacent sync ranges. Don't freak out and delete a message
   *       just because it didn't show up in this exact range we asked
   *       for. Only delete the message if we checked all around where
   *       it was supposed to show up, and it never did.
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
    var scope = logic.subscope(this, { startTS: startTS, endTS: endTS });

    if (startTS && endTS && SINCE(startTS, endTS)) {
      logic(scope, 'illegalSync');
      doneCallback('invariant');
      return;
    }

    var self = this;
    var storage = self._storage;
    var completed = false;

    console.log('syncDateRange:', startTS, endTS);
    logic(scope, 'syncDateRange_begin');

    // IMAP Search

    // We don't care about deleted messages, it's best that we're not
    // aware of them. However, it's important to keep in mind that
    // this means that EXISTS provides us with an upper bound on the
    // messages in the folder since we are blinding ourselves to
    // deleted messages.
    var searchOptions = { not: { deleted: true } };
    if (startTS) {
      searchOptions.since = new Date(startTS);
    }
    if (endTS) {
      searchOptions.before = new Date(endTS);
    }

    var imapSearchPromise = new Promise(function(resolve) {
      this._timelySyncSearch(
        searchOptions,
        resolve,
        function abortedSearch() {
          if (completed) {
            return;
          }
          completed = true;
          this._LOG.syncDateRange_end(0, 0, 0, startTS, endTS);
          logic(scope, 'syncDateRange_end', {
                  full: 0, flags: 0, deleted: 0
                });
          doneCallback('aborted');
        }.bind(this),
        progressCallback,
        /* isRetry: */ false);
    }.bind(this));

    // Database Fetch

    // Fetch messages from the database, extending the search by a day
    // on either side to prevent timezone-related problems (bug 886534).

    var dbStartTS = (startTS ? startTS - $sync.IMAP_SEARCH_AMBIGUITY_MS : null);
    var dbEndTS = (endTS ? endTS + $sync.IMAP_SEARCH_AMBIGUITY_MS : null);
    logic(scope, 'database-lookup', {
      dbStartTS: dbStartTS,
      dbEndTS: dbEndTS
    });
    var databaseFetchPromise = new Promise(function(resolve) {
      storage.getAllMessagesInImapDateRange(dbStartTS, dbEndTS, resolve);
    });

    // Combine the results:

    Promise.all([
      imapSearchPromise,
      databaseFetchPromise
    ]).then(function(results) {
      var serverUIDs = results[0];
      var dbHeaders = results[1];
      var effectiveEndTS = endTS || quantizeDate(NOW() + DAY_MILLIS);
      var curDaysDelta = Math.round((effectiveEndTS - startTS) / DAY_MILLIS);

      // ----------------------------------------------------------------
      // BISECTION SPECIAL CASE: If we have a lot of messages to
      // process and we're searching more than one day, we can shrink
      // our search.

      var shouldBisect = (serverUIDs.length > $sync.BISECT_DATE_AT_N_MESSAGES &&
                          curDaysDelta > 1);

      console.log(
        '[syncDateRange]',
        'Should bisect?', shouldBisect ? '***YES, BISECT!***' : 'no.',
        'curDaysDelta =', curDaysDelta,
        'serverUIDs.length =', serverUIDs.length);

      if (shouldBisect) {
        // mark the bisection abort...
        logic(scope, 'syncDateRange_end');
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
        } else {
          self.syncDateRange(
            bisectInfo.newStartTS,
            bisectInfo.newEndTS,
            accuracyStamp,
            doneCallback,
            progressCallback);
        }
        return;
      }

      // end bisection special case
      // ----------------------------------------------------------------

      if (progressCallback) {
        progressCallback(0.25);
      }

      // Combine the UIDs from local headers with server UIDs.

      var uidSet = new Set();
      var serverUidSet = new Set();
      var localHeaderMap = {};

      dbHeaders.forEach(function(header) {
        // Ignore not-yet-synced local messages (messages without a
        // srvid), such as messages from a partially-completed local
        // move. Because they have no server ID, we can't compare them
        // to anything currently on the server anyway.
        if (header.srvid !== null) {
          uidSet.add(header.srvid);
          localHeaderMap[header.srvid] = header;
        }
      });

      serverUIDs.forEach(function(uid) {
        uidSet.add(uid);
        serverUidSet.add(uid);
      });

      var imapSyncOptions = {
        connection: self._conn,
        storage: storage,
        newUIDs: [],
        knownUIDs: [],
        knownHeaders: []
      };

      var numDeleted = 0;
      var latch = $allback.latch();

      // Figure out which messages are new, updated, or deleted.
      uidSet.forEach(function(uid) {
        var localHeader = localHeaderMap[uid] || null;
        var hasServer = serverUidSet.has(uid);

        // New
        if (!localHeader && hasServer) {
          imapSyncOptions.newUIDs.push(uid);
          logic(scope, 'new-uid', { uid: uid });
        }
        // Updated
        else if (localHeader && hasServer) {
          imapSyncOptions.knownUIDs.push(uid);
          imapSyncOptions.knownHeaders.push(localHeader);

          if (localHeader.imapMissingInSyncRange) {
            localHeader.imapMissingInSyncRange = null;
            logic(scope, 'found-missing-uid', { uid: uid });
            storage.updateMessageHeader(
              localHeader.date, localHeader.id, true, localHeader,
              /* body hint */ null, latch.defer(), { silent: true });
          }

          logic(scope, 'updated-uid', { uid: uid });
        }
        // Deleted or Ambiguously Deleted
        else if (localHeader && !hasServer) {
          // So, how long has this message been missing for?
          var fuzz = $sync.IMAP_SEARCH_AMBIGUITY_MS;
          var date = localHeader.date;

          // There are 3 possible cases for imapMissingInSyncRange:
          // 1) We don't have one, so just use the current search range.
          // 2) It's disjoint from the current search range, so just use the
          //    current search range.  We do this because we only track one
          //    range for the message, and unioning disjoint ranges erroneously
          //    assumes that we know something about the gap range *when we do
          //    not*.  This situation arises because we previously had synced
          //    backwards in time so that we were on the "old" ambiguous side
          //    of the message.  We now must be on the "new" ambiguous side.
          //    Since our sync range (currently) only ever moves backwards in
          //    time, it is safe for us to discard the information about the
          //    "old" side because we'll get that coverage again soon.
          // 3) It overlaps the current range and we can take their union.
          var missingRange;
          if (!localHeader.imapMissingInSyncRange || // (#1)
              ((localHeader.imapMissingInSyncRange.endTS < startTS) || // (#2)
               (localHeader.imapMissingInSyncRange.startTS > endTS))) {
            // adopt/clobber!
            // (Note that "Infinity" JSON stringifies to null, so be aware when
            // looking at logs involving this code.  But the values are
            // structured cloned for bridge and database purposes and so remain
            // intact.)
            missingRange = localHeader.imapMissingInSyncRange =
              { startTS: startTS || 0, endTS: endTS || Infinity };
          } else { // (#3, union!)
            missingRange = localHeader.imapMissingInSyncRange;
            // Make sure to treat 'null' startTS and endTS correctly.
            // (This is a union range.  We can state that we have not found the
            // message in the time range SINCE missingRange.startTS and BEFORE
            // missingRange.endTS.)
            missingRange.startTS = Math.min(startTS || 0,
                                            missingRange.startTS || 0);
            missingRange.endTS = Math.max(endTS || Infinity,
                                          missingRange.endTS || Infinity);
          }

          // Have we looked all around where the message is supposed
          // to be, and the server never coughed it up? Delete it.
          // (From a range perspective, we want to ensure that the missingRange
          // completely contains the date +/- fuzz range.  We use an inclusive
          // comparison in both cases because we are comparing two ranges, not
          // a single date and a range.)
          if (missingRange.startTS <= date - fuzz &&
              missingRange.endTS >= date + fuzz) {
            logic(scope, 'unambiguously-deleted-uid',
                  { uid: uid, missingRange: missingRange });
            storage.deleteMessageHeaderAndBodyUsingHeader(localHeader);
            numDeleted++;
          }
          // Or we haven't looked far enough... maybe it will show up
          // later. We've already marked the updated "missing" range above.
          else {
            logic(scope, 'ambiguously-missing-uid',
                  { uid: uid, missingRange: missingRange,
                    rangeToDelete: { startTS: date - fuzz, endTS: date + fuzz },
                    syncRange: { startTS: startTS, endTS: endTS }});

            storage.updateMessageHeader(
              localHeader.date, localHeader.id, true, localHeader,
              /* body hint */ null, latch.defer(), { silent: true });
          }
        }
      });

      // Now that we've reconciled the difference between the items
      // listen on the server and the items on the client, we can pass
      // the hard download work into $imapsync.Sync.
      latch.then(function() {
        var uidSync = new $imapsync.Sync(imapSyncOptions);
        uidSync.onprogress = progressCallback;
        uidSync.oncomplete = function(newCount, knownCount) {
          logic(scope, 'syncDateRange_end', {
            full: newCount,
            flags: knownCount,
            deleted: numDeleted
          });

          // BrowserBox returns an integer modseq, but it's opaque and
          // we already deal with strings, so cast it here.
          var modseq = (self.box.highestModseq || '') + '';
          storage.markSyncRange(startTS, endTS, modseq, accuracyStamp);

          if (!completed) {
            completed = true;
            self.clearErrorHandler();
            doneCallback(null, null, newCount + knownCount, startTS, endTS);
          }
        };
      });
    }.bind(this));
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
  async downloadBodyReps() {
    var args = Array.slice(arguments);
    var self = this;

    $imapchew = await import('./imapchew');
    $imapbodyfetcher = await import('./protocol/bodyfetcher');
    $imaptextparser = await import('./protocol/textparser');
    $imapsnippetparser = await import('./protocol/snippetparser');

    (self.downloadBodyReps = self._lazyDownloadBodyReps).apply(self, args);
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
        if (rep.isDownloaded) {
          return;
        }

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
        if (bytesToFetch <= 0) {
          bytesToFetch = 64;
        }

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

      $imapchew.updateMessageWithFetch(header, body, req, resp);

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
  async downloadBodies() {
    var args = Array.slice(arguments);
    var self = this;

    $imapchew = await import('./imapchew');
    $imapbodyfetcher = await import('./protocol/bodyfetcher');
    $imapsnippetparser = await import('./protocol/snippetparser');

    (self.downloadBodies = self._lazyDownloadBodies).apply(self, args);
  },

  downloadMessageAttachments: function(uid, partInfos, callback/*, progress*/) {
    require(['mimeparser'], function(MimeParser) {
      var conn = this._conn;

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

      latch.then(function(/*results*/) {
        callback(anyError, bodies);
      });
    }.bind(this));
  },

  shutdown: function() {
  },
};

export function ImapFolderSyncer(account, folderStorage) {
  this._account = account;
  this.folderStorage = folderStorage;

  logic.defineScope(this, 'ImapFolderSyncer', {
    accountId: account.id,
    folderId: folderStorage.folderId
  });


  this.folderConn = new ImapFolderConn(account, folderStorage);
}
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
  },
};

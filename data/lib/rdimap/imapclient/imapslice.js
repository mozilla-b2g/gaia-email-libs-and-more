/**
 * Presents a message-centric view of a slice of time from IMAP search results.
 *
 * == Use-case assumptions
 *
 * - We are backing a UI showing a list of time-ordered messages.  This can be
 *   the contents of a folder, on-server search results, or the
 *   (server-facilitated) list of messages in a conversation.
 * - We want to fetch more messages as the user scrolls so that the entire
 *   contents of the folder/search results list are available.
 * - We want to show the message as soon as possible.  So we can show a message
 *   in the list before we have its snippet.  However, we do want the
 *   bodystructure before we show it so we can accurately know if it has
 *   attachments.
 * - We want to update the state of the messages in real-time as we hear about
 *   changes from the server, such as another client starring a message or
 *   marking the message read.
 * - We will synchronize some folders with either a time and/or message count
 *   threshold.
 * - We want mutations made locally to appear as if they are applied
 *   immediately, even if we are operating offline.
 *
 * == Efficiency desires
 *
 * - Avoid redundant network traffic by caching our results using IndexedDB.
 * - Keep the I/O burden and overhead low from caching/sync.  We know our
 *   primary IndexedDB implementation is backed by SQLite with full
 *   transaction commits corresponding to IndexedDB transaction commits.
 *   We also know that all IndexedDB work gets marshaled to another thread.
 *   Since the server is the final word in state, except for mutations we
 *   trigger, we don't need to be aggressive about persisting state.
 *   Accordingly, let's persist our data in big blocks only on major
 *   transitions (folder change) or when our memory usage is getting high.
 *   (If we were using LevelDB, large writes would probably be less
 *   desirable.)
 *
 * == Of slices, folders, and gmail
 *
 * It would be silly for a slice that is for browsing the folder unfiltered and
 * a slice that is a result of a search to act as if they were dealing with
 * different messages.  Similarly, it would be silly in gmail for us to fetch
 * a message that we know is the same message across multiple (labels as)
 * folders.  So we abstract away the storage details to `ImapFolderStorage`.
 *
 * == Latency, offline access, and IMAP
 *
 * The fundamental trade-off is between delaying showing things in the UI and
 * showing them and then having a bunch of stuff happen a split-second later.
 * (Messages appearing, disappearing, having their status change, etc.)
 *
 **/

define(
  [
    'rdcommon/log',
    'mailparser/mailparser',
    './a64',
    './allback',
    './util',
    './imapchew',
    'module',
    'exports'
  ],
  function(
    $log,
    $mailparser,
    $a64,
    $allback,
    $imaputil,
    $imapchew,
    $module,
    exports
  ) {
const allbackMaker = $allback.allbackMaker,
      bsearchForInsert = $imaputil.bsearchForInsert,
      bsearchMaybeExists = $imaputil.bsearchMaybeExists;

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
 * Header info comparator that orders messages in order of numerically
 * decreasing date and UIDs.  So new messages come before old messages,
 * and messages with higher UIDs (newer-ish) before those with lower UIDs
 * (when the date is the same.)
 */
function cmpHeaderYoungToOld(a, b) {
  var delta = b.date - a.date;
  if (delta)
    return delta;
  // favor larger UIDs because they are newer-ish.
  return b.id - a.id;
}


/**
 * Book-keeping and limited agency for the slices.
 *
 * The way this works is that we get opened and
 */
function ImapSlice(bridgeHandle, storage, _parentLog) {
  this._bridgeHandle = bridgeHandle;
  bridgeHandle.__listener = this;
  this._storage = storage;
  this._LOG = LOGFAB.ImapSlice(this, _parentLog, bridgeHandle.id);

  // The time range of the headers we are looking at right now.
  this.startTS = null;
  this.startUID = null;
  this.endTS = null;
  this.endUID = null;

  /**
   * Will we ingest new messages we hear about in our 'start' direction?
   */
  this.openStart = true;
  /**
   * Will we ingest new messages we hear about in our 'end' direction?
   */
  this.openEnd = true;

  this.waitingOnData = false;

  this.headers = [];
  this.desiredHeaders = INITIAL_FILL_SIZE;
}
exports.ImapSlice = ImapSlice;
ImapSlice.prototype = {
  /**
   * Force an update of our current date range.
   */
  refresh: function() {
    this._storage.refreshSlice(this);
  },

  reqNoteRanges: function() {
    // XXX implement and contend with the generals problem.  probably just have
    // the other side name the values by id rather than offsets.
  },

  reqGrow: function(dirMagnitude) {
  },

  setStatus: function(status) {
    if (!this._bridgeHandle)
      return;

    this._bridgeHandle.sendStatus(status, status === 'synced');
  },

  batchAppendHeaders: function(headers, moreComing) {
    this._LOG.headersAppended(headers);
    this._bridgeHandle.sendSplice(this.headers.length, 0, headers,
                                  true, moreComing);
    this.headers = this.headers.concat(headers);
  },

  /**
   * Tell the slice about a header it should be interested in.  This should
   * be unconditionally called by a sync populating this slice, or conditionally
   * called when the header is in the time-range of interest and a refresh,
   * cron-triggered sync, or IDLE/push tells us to do so.
   */
  onHeaderAdded: function(header) {
    if (!this._bridgeHandle)
      return;

    if (this.startTS === null ||
        BEFORE(header.date, this.startTS)) {
      this.startTS = header.date;
      this.startUID = header.id;
    }
    else if (header.date === this.startTS &&
             header.id < this.startUID) {
      this.startUID = header.id;
    }
    if (this.endTS === null ||
        STRICTLY_AFTER(header.date, this.endTS)) {
      this.endTS = header.date;
      this.endUID = header.id;
    }
    else if (header.date === this.endTS &&
             header.id > this.endUID) {
      this.endUID = header.id;
    }

    var idx = bsearchForInsert(this.headers, header,
                               cmpHeaderYoungToOld);
    this._LOG.headerAdded(idx, header);
    this._bridgeHandle.sendSplice(idx, 0, [header],
                                  this.waitingOnData, this.waitingOnData);
    this.headers.splice(idx, 0, header);
  },

  /**
   * Tells the slice that a header it should know about has changed.  (If
   * this is a search, it's okay for it not to know...)
   */
  onHeaderModified: function(header) {
    if (!this._bridgeHandle)
      return;

    // this can only affect flags which will not affect ordering
    var idx = bsearchMaybeExists(this.headers, header,
                                 cmpHeaderYoungToOld);
    if (idx !== null) {
      this._LOG.headerModified(idx, header);
      this._bridgeHandle.sendUpdate([idx, header]);
    }
  },

  /**
   * Tells the slice that a header it should know about has been removed.
   */
  onHeaderRemoved: function(header) {
    if (!this._bridgeHandle)
      return;

    var idx = bsearchMaybeExists(this.headers, header,
                                 cmpHeaderYoungToOld);
    if (idx !== null) {
      this._LOG.headerRemoved(idx, header);
      this._bridgeHandle.sendSplice(idx, 1, [],
                                    this.waitingOnData, this.waitingOnData);
      this.headers.splice(idx, 1);

      // update time-ranges if required...
      if (header.date === this.endTS && header.id === this.endUID) {
        if (!this.headers.length) {
          this.endTS = null;
          this.endUID = null;
        }
        else {
          this.endTS = this.headers[0].date;
          this.endUID = this.headers[0].id;
        }
      }
      if (header.date === this.startTS && header.id === this.startUID) {
        if (!this.headers.length) {
          this.startTS = null;
          this.startUID = null;
        }
        else {
          var lastHeader = this.headers[this.headers.length - 1];
          this.startTS = lastHeader.date;
          this.startUID = lastHeader.id;
        }
      }
    }
  },

  die: function() {
    this._bridgeHandle = null;
    this._storage.dyingSlice(this);
    this._LOG.__die();
  },
};

const BASELINE_SEARCH_OPTIONS = ['!DRAFT', '!DELETED'];

/**
 * What is the maximum number of bytes a block should store before we split
 * it?
 */
const MAX_BLOCK_SIZE = 96 * 1024,
/**
 * How many bytes should we target for the small part when splitting 1:2?
 */
      BLOCK_SPLIT_SMALL_PART = 32 * 1024,
/**
 * How many bytes should we target for equal parts when splitting 1:1?
 */
      BLOCK_SPLIT_EQUAL_PART = 48 * 1024,
/**
 * How many bytes should we target for the large part when splitting 1:2?
 */
      BLOCK_SPLIT_LARGE_PART = 64 * 1024;

////////////////////////////////////////////////////////////////////////////////
// Time
//
// == JS Dates
//
// We primarily deal in UTC timestamps.  When we need to talk dates with IMAP
// (see next section), we need these timestamps to line up with midnight for
// a given day.  We do not need to line up with weeks, months, or years,
// saving us a lot of complexity.
//
// Day algebra is straightforward because JS Date objects have no concept of
// leap seconds.  We don't need to worry that a leap second will cause adding
// a day to be less than or more than a day.  Hooray!
//
// == IMAP and Time
//
// The stock IMAP SEARCH command's SINCE and BEFORE predicates only operate on
// whole-dates (and ignore the non-date time parts).  Additionally, SINCE is
// inclusive and BEFORE is exclusive.
//
// We use JS millisecond timestamp values throughout, and it's important to us
// that our date logic is consistent with IMAP's time logic where relevant.
// All of our IMAP-exposed time-interval related logic operates on day
// granularities.  Our timestamp/date values are always normalized to midnight
// which happily works out with intuitive range operations.
//
// Observe the pretty ASCII art where as you move to the right you are moving
// forward in time.
//
//        ________________________________________
// BEFORE)| midnight (0 millis) ... 11:59:59:999 |
//        [SINCE......................................
//
// Our date range comparisons (noting that larger timestamps are 'younger') are:
// SINCE analog:  (testDate >= comparisonDate)
//   testDate is as-recent-as or more-recent-than the comparisonDate.
// BEFORE analog: (testDate < comparisonDate)
//   testDate is less-recent-than the comparisonDate
//
// Because "who is the test date and who is the range value under discussion"
// can be unclear and the numerical direction of time is not always intuitive,
// I'm introducing simple BEFORE and SINCE helper functions to try and make
// the comparison logic ridiculously explicit as well as calling out where we
// are being consistent with IMAP.
//
// Not all of our time logic is consistent with IMAP!  Specifically, use of
// exclusive time bounds without secondary comparison keys means that ranges
// defined in this way cannot spread messages with the same timestamp over
// multiple ranges.  This allows for pathological data structure situations
// where there's too much data in a data block, etc.
// Our date ranges are defined by 'startTS' and 'endTS'.  Using math syntax, our
// IMAP-consistent time ranges end up as: [startTS, endTS).  It is always true
// that BEFORE(startTS, endTS) and SINCE(endTS, startTS) in these cases.
//
// As such, I've also created an ON_OR_BEFORE helper that allows equivalence and
// STRICTLY_AFTER that does not check equivalence to round out all possibilities
// while still being rather explicit.


/**
 * IMAP-consistent date comparison; read this as "Is `testDate` BEFORE
 * `comparisonDate`"?
 *
 * !BEFORE(a, b) === SINCE(a, b)
 */
function BEFORE(testDate, comparisonDate) {
  // testDate is numerically less than comparisonDate, so it is chronologically
  // before it.
  return testDate < comparisonDate;
}

function ON_OR_BEFORE(testDate, comparisonDate) {
  return testDate <= comparisonDate;
}

/**
 * IMAP-consistent date comparison; read this as "Is `testDate` SINCE
 * `comparisonDate`"?
 *
 * !SINCE(a, b) === BEFORE(a, b)
 */
function SINCE(testDate, comparisonDate) {
  // testDate is numerically greater-than-or-equal-to comparisonDate, so it
  // chronologically after/since it.
  return testDate >= comparisonDate;
}

function STRICTLY_AFTER(testDate, comparisonDate) {
  return testDate > comparisonDate;
}

function IN_BS_DATE_RANGE(testDate, startTS, endTS) {
  return testDate >= startTS && testDate < endTS;
}

//function DATE_RANGES_OVERLAP(A_startTS, A_endTS, B_startTS, B_endTS) {
//}

/**
 * The estimated size of a `HeaderInfo` structure.  We are using a constant
 * since there is not a lot of variability in what we are storing and this
 * is probably good enough.
 */
const HEADER_EST_SIZE_IN_BYTES = 200;

const DAY_MILLIS = 24 * 60 * 60 * 1000;

/**
 * Testing override that when present replaces use of Date.now().
 */
var TIME_WARPED_NOW = null, FUTURE_TIME_WARPED_NOW = null;
/**
 * Pretend that 'now' is actually a fixed point in time for the benefit of
 * unit tests using canned message stores.
 */
exports.TEST_LetsDoTheTimewarpAgain = function(fakeNow) {
  if (typeof(fakeNow) !== 'number')
    fakeNow = fakeNow.valueOf();
  TIME_WARPED_NOW = fakeNow;
  // because of exclusive time comparison ops , we actually want to use the first
  // day after the TIME_WARPED_NOW...
  FUTURE_TIME_WARPED_NOW = quantizeDate(fakeNow + DAY_MILLIS);
};

/**
 * Make a timestamp some number of days in the past, quantized to midnight of
 * that day.  This results in rounding up; if it's noon right now and you
 * ask for 2 days ago, you really get 2.5 days worth of time.
 */
function makeDaysAgo(numDays) {
  var //now = quantizeDate(TIME_WARPED_NOW || Date.now()),
      //past = now - numDays * DAY_MILLIS;
      past = FUTURE_TIME_WARPED_NOW - (numDays + 1) * DAY_MILLIS;
  return past;
}
function makeDaysBefore(date, numDaysBefore) {
  return quantizeDate(date) - numDaysBefore * DAY_MILLIS;
}
/**
 * Quantize a date to midnight on that day.
 */
function quantizeDate(date) {
  if (typeof(date) === 'number')
    date = new Date(date);
  return date.setHours(0, 0, 0, 0).valueOf();
}

/**
 * How recent is recent enough for us to not have to talk to the server before
 * showing results?
 */
const RECENT_ENOUGH_TIME_THRESH = 6 * 60 * 60 * 1000;

////////////////////////////////////////////////////////////////////////////////

/**
 * How many messages should we send to the UI in the first go?
 */
const INITIAL_FILL_SIZE = 15;

/**
 * How many days in the past should we first look for messages.
 */
const INITIAL_SYNC_DAYS = 7;
/**
 * When looking further into the past, how big a bite of the past should we
 * take?
 */
const INCREMENTAL_SYNC_DAYS = 14;

/**
 * What's the maximum number of messages we should ever handle in a go and
 * where we should start failing by pretending like we haven't heard of the
 * excess messages?  This is a question of message time-density and not a
 * limitation on the number of messages in a folder.
 *
 * This could be eliminated by adjusting time ranges when we know the
 * density is high (from our block indices) or by re-issuing search results
 * when the server is telling us more than we can handle.
 */
const TOO_MANY_MESSAGES = 2000;

/**
 * Fetch parameters to get the headers / bodystructure; exists to reuse the
 * object since every fetch is the same.  Note that imap.js always gives us
 * FLAGS and INTERNALDATE so we don't need to ask for that.
 *
 * We are intentionally not using ENVELOPE because Thunderbird intentionally
 * defaults to to not using ENVELOPE.  Per bienvenu in
 * https://bugzilla.mozilla.org/show_bug.cgi?id=402594#c33 "We stopped using it
 * by default because servers often had issues with it so it was more trouble
 * than it was worth."
 *
 * Of course, imap.js doesn't really support ENVELOPE outside of bodystructure
 * right now either, but that's a lesser issue.  We probably don't want to trust
 * that data, however, if we don't want to trust normal ENVELOPE.
 */
const INITIAL_FETCH_PARAMS = {
  request: {
    headers: ['FROM', 'TO', 'CC', 'BCC', 'SUBJECT', 'REPLY-TO', 'MESSAGE-ID'],
    struct: true
  },
};

/**
 * Fetch parameters to just get the flags, which is no parameters because
 * imap.js always fetches them right now.
 */
const FLAG_FETCH_PARAMS = {
  request: {
  },
};


/**
 * Folder connections do the actual synchronization logic.  They are associated
 * with one or more `ImapSlice` instances that issue the requests that trigger
 * synchronization.  Storage is handled by `ImapFolderStorage` or
 * `GmailMessageStorage` instances.
 *
 * == IMAP Protocol Connection Management
 *
 * We request IMAP protocol connections from the account.  There is currently no
 * way for us to surrender our connection or indicate to the account that we
 * are capable of surrending the connection.  That might be a good idea, though.
 *
 * All accesses to a folder's connection should be done through an
 * `ImapFolderConn`, even if the actual mutation logic is being driven by code
 * living in the account.
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
}
ImapFolderConn.prototype = {
  /**
   * Acquire a connection and invoke the callback once we have it and we have
   * entered the folder.
   *
   * XXX This is inherently dangerous in the face of concurrent attempts to
   * call this method or check whether it has completed.  We need to move to
   * our queue of operations on the folder, or ensure that a higher level layer
   * is enforcing this.  To be done with proper mutation logic impl.
   */
  acquireConn: function(callback) {
    var self = this;
    this._account.__folderDemandsConnection(
      this._storage.folderId,
      function(conn) {
        self._conn = conn;
        // Now we have a connection, but it's not in the folder.
        // (If we were doing fancier sync like QRESYNC, we would not enter
        // in such a blase fashion.)
        self._conn.openBox(self._storage.folderMeta.path,
                           function openedBox(err, box) {
            if (err) {
              console.error('Problem entering folder',
                            self._storage.folderMeta.path);
              return;
            }
            self.box = box;
            callback(self);
          });
      });
  },

  relinquishConn: function() {
    if (!this._conn)
      return;

    this._account.__folderDoneWithConnection(this._storage.folderId,
                                             this._conn);
    this._conn = null;
  },

  /**
   * Wrap the search command and shirk the errors for now.  I was thinking we
   * might have this do automatic connection re-establishment, etc., but I think
   * it makes more sense to have the IMAP protocol connection object do that
   * under the hood or in participation with the account class via another
   * interface since it already handles command queueing.
   *
   * This also conveniently hides the connection acquisition asynchrony.
   */
  _reliaSearch: function(searchOptions, callback) {
    // If we don't have a connection, get one, then re-call.
    if (!this._conn) {
      this.acquireConn(this._reliaSearch.bind(this, searchOptions, callback));
      return;
    }

    this._conn.search(searchOptions, function(err, uids) {
        if (err) {
          console.error('Search error on', searchOptions, 'err:', err);
          return;
        }
        callback(uids);
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
   */
  syncDateRange: function(startTS, endTS, newToOld, doneCallback) {
    var searchOptions = BASELINE_SEARCH_OPTIONS.concat(), self = this,
      storage = self._storage;
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

        // -- infer deletion, flag to distinguish known messages
        // rather than splicing lists and causing shifts, we null out values.
        for (var iMsg = 0; iMsg < headers.length; iMsg++) {
          var header = headers[iMsg];
          var idxUid = serverUIDs.indexOf(header.id);
          // deleted!
          if (idxUid === -1) {
            storage.deleteMessageHeaderAndBody(header);
            numDeleted++;
            headers[iMsg] = null;
            continue;
          }
          // null out the UID so the non-null values in the search are the
          // new messages to us.
          serverUIDs[idxUid] = null;
          // but save the UID so we can do a flag-check.
          knownUIDs.push(header.id);
        }

        var newUIDs = compactArray(serverUIDs); // (re-labeling, same array)
        if (numDeleted)
          compactArray(headers);

        self._commonSync(
          newUIDs, knownUIDs, headers,
          function(newCount, knownCount) {
            self._LOG.syncDateRange_end(newCount, knownCount, numDeleted,
                                        startTS, endTS);
            self._storage.markSyncRange(startTS, endTS, modseq, Date.now());
            doneCallback();
          });
      });

    this._LOG.syncDateRange_begin(null, null, null, startTS, endTS);
    this._reliaSearch(searchOptions, callbacks.search);
    this._storage.getAllMessagesInDateRange(startTS, endTS,
                                            callbacks.db);
  },

  searchDateRange: function(endTS, startTS, newToOld, searchParams,
                            slice) {
    var searchOptions = BASELINE_SEARCH_OPTIONS.concat(searchParams);
    if (startTS)
      searchOptions.push(['SINCE', startTS]);
    if (endTS)
      searchOptions.push(['BEFORE', endTS]);
  },

  /**
   * Given a list of new-to-us UIDs and known-to-us UIDs and their corresponding
   * headers, synchronize the flags for the known UIDs' headers and fetch and
   * create the header and body objects for the new UIDS.
   *
   * First we fetch the headers/bodystructures for the new UIDs all in one go;
   * all of these headers are going to end up in-memory at the same time, so
   * batching won't let us reduce the overhead right now.  We process them
   * to determine the body parts we should fetch as the results come in.  Once
   * we have them all, we sort them by date, endTS-to-startTS for the third
   * step and start issuing/pipelining the requests.
   *
   * Second, we issue the flag update requests for the known-to-us UIDs.  This
   * is done second so it can help avoid wasting the latency of the round-trip
   * that would otherwise result between steps one and three.  (Although we
   * could also mitigate that by issuing some step three requests even as
   * the step one requests are coming in; our sorting doesn't have to be
   * perfect and may already be reasonably well ordered if UIDs correlate
   * with internal date well.)
   *
   * Third, we fetch the body parts in our newest-to-startTS order, adding
   * finalized headers and bodies as we go.
   */
  _commonSync: function(newUIDs, knownUIDs, knownHeaders, doneCallback) {
    var conn = this._conn, storage = this._storage;
    // -- Fetch headers/bodystructures for new UIDs
    var newChewReps = [];
    if (newUIDs.length) {
      var newFetcher = this._conn.fetch(newUIDs, INITIAL_FETCH_PARAMS);
      newFetcher.on('message', function onNewMessage(msg) {
          msg.on('end', function onNewMsgEnd() {
            newChewReps.push($imapchew.chewHeaderAndBodyStructure(msg));
          });
        });
      newFetcher.on('error', function onNewFetchError(err) {
          // XXX the UID might have disappeared already?  we might need to have
          // our initiating command re-do whatever it's up to.  Alternatively,
          // we could drop back from a bulk fetch to a one-by-one fetch.
          console.warn('New UIDs fetch error, ideally harmless:', err);
        });
      newFetcher.on('end', function onNewFetchEnd() {
          // sort the messages, endTS to startTS (aka numerically descending)
          newChewReps.sort(function(a, b) {
              return b.msg.date - a.msg.date;
            });

          // - issue the bodypart fetches.
          // Use mailparser's body parsing capabilities, albeit not entirely in
          // the way it was intended to be used since it wants to parse full
          // messages.
          var mparser = new $mailparser.MailParser();
          function setupBodyParser(partDef) {
            mparser._state = 0x2; // body
            mparser._remainder = '';
            mparser._currentNode = null;
            mparser._currentNode = mparser._createMimeNode(null);
            // nb: mparser._multipartTree is an empty list (always)
            mparser._currentNode.meta.contentType =
              partDef.type + '/' + partDef.subtype;
            mparser._currentNode.meta.charset =
              partDef.params && partDef.params.charset;
            mparser._currentNode.meta.transferEncoding =
              partDef.encoding;
            mparser._currentNode.meta.textFormat =
              partDef.params && partDef.params.format;
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
            return mparser._currentNode.content;
          }

          // XXX imap.js is currently not capable of issuing/parsing multiple
          // literal results from a single fetch result line.  It's not a
          // fundamentally hard problem, but I'd rather defer messing with its
          // parse loop (and internal state tracking) until a future time when
          // I can do some other cleanup at the same time.  (The subsequent
          // literals are just on their own lines with an initial space and then
          // the named literal.  Ex: " BODY[1.2] {2463}".)
          //
          // So let's issue one fetch per body part and then be happy when we've
          // got them all.
          var pendingFetches = 0;
          newChewReps.forEach(function(chewRep, iChewRep) {
            var partsReceived = [];
            chewRep.bodyParts.forEach(function(bodyPart) {
              var opts = { request: { body: bodyPart.partID } };
              pendingFetches++;
              var fetcher = conn.fetch(chewRep.msg.id, opts);
              setupBodyParser(bodyPart);
              fetcher.on('message', function(msg) {
                setupBodyParser(bodyPart);
                msg.on('data', bodyParseBuffer);
                msg.on('end', function() {
                  partsReceived.push(finishBodyParsing());

                  // -- Process
                  if (partsReceived.length === chewRep.bodyParts.length) {
                    if ($imapchew.chewBodyParts(chewRep, partsReceived,
                                                storage.folderId)) {
                      storage.addMessageHeader(chewRep.header);
                      storage.addMessageBody(chewRep.header, chewRep.bodyInfo);
                    }
                   // If this is the last chew rep, then use its completion
                   // to report our completion.
                    if (--pendingFetches === 0)
                      doneCallback(newUIDs.length, knownUIDs.length);
                  }
                });
              });
            });
          });
        });
    }

    // -- Fetch updated flags for known UIDs
    if (knownUIDs.length) {
      var knownFetcher = this._conn.fetch(knownUIDs, FLAG_FETCH_PARAMS);
      var numFetched = 0;
      knownFetcher.on('message', function onKnownMessage(msg) {
          // (Since we aren't requesting headers, we should be able to get
          // away without registering this next event handler and just process
          // msg right now, but let's wait on an optimization pass.)
          msg.on('end', function onKnownMsgEnd() {
            var i = numFetched++;
            // RFC 3501 doesn't seem to require that we get results in the order
            // we request them, so use indexOf if things don't line up.
            if (knownHeaders[i].id !== msg.id) {
              i = knownUIDs.indexOf(msg.id);
              // If it's telling us about a message we don't know about, run away.
              if (i === -1) {
                console.warn("Server fetch reports unexpected message:", msg.id);
                return;
              }
            }
            var header = knownHeaders[i];
            // (msg.flags comes sorted and we maintain that invariant)
            if (header.flags.toString() !== msg.flags.toString()) {
              header.flags = msg.flags;
              storage.updateMessageHeader(header.date, header.id, true, header);
            }
            else {
              storage.unchangedMessageHeader(header);
            }
          });
        });
      knownFetcher.on('error', function onKnownFetchError(err) {
          // XXX the UID might have disappeared already?  we might need to have
          // our initiating command re-do whatever it's up to.  Alternatively,
          // we could drop back from a bulk fetch to a one-by-one fetch.
          console.warn('Known UIDs fetch error, ideally harmless:', err);
        });
      if (!newUIDs.length) {
        knownFetcher.on('end', function() {
            doneCallback(newUIDs.length, knownUIDs.length);
          });
      }
    }

    if (!knownUIDs.length && !newUIDs.length) {
      doneCallback(newUIDs.length, knownUIDs.length);
    }
  },

  shutdown: function() {
    this._LOG.__die();
  },
};

/**
 * Per-folder message caching/storage named by their UID.  Storage also relies
 * on the IMAP internaldate of the message for efficiency.  Accordingly,
 * when performing a lookup, we either need the exact date of the message or
 * a reasonable bounded time range in which it could fall (which should be a
 * given for date range scans).
 *
 * Storage is done using IndexedDB, with message header information and message
 * body information stored in separate blocks of information.  Blocks are
 * loaded on demand, although preferably hints are received so we can pre-load
 * information.
 *
 * Blocks are discarded from memory (and written back if mutated) when there are
 * no longer live `ImapSlice` instances that care about the time range and we
 * are experiencing memory pressure.  Dirty blocks are periodically written
 * to storage even if there is no memory pressure at notable application and
 * synchronization state milestones.  Since the server is the canonical message
 * store, we are not exceedingly concerned about losing state.
 *
 * Messages are discarded from storage when experiencing storage pressure.  We
 * figure it's better to cache what we have until it's known useless (deleted
 * messages) or we definitely need the space for something else.
 *
 * == Concurrency and I/O
 *
 * The logic in this class can operate synchronously as long as the relevant
 * header/body blocks are in-memory.  For simplicity, we (asynchronously) defer
 * execution of calls that mutate state while loads are in-progress; callers
 * will not block.  This simplifies our implementation and thinking about our
 * implementation without making life for our users much worse.
 *
 * Specifically, all UI requests for data will be serviced immediately if the
 * data is available.  If the data is not available, the wait would have
 * happened anyways.  Mutations will be enqueued, but are always speculatively
 * assumed to succeed by the UI anyways so when they are serviced is not
 * exceedingly important other than a burden on us to surface in the UI that
 * we still have some state to synchronize to the server so the user does
 * not power-off their phone quite yet.
 *
 * == Types
 *
 * @typedef[AccuracyRangeInfo @dict[
 *   @key[endTS DateMS]
 *   @key[startTS DateMS]
 *   @key[fullSync @dict[
 *     @key[highestModseq #:optional String]{
 *       The highest modseq for this range, if we have one.  This would be the
 *       value reported on folder entry, plus any maximization that occurs if we
 *       utilized IDLE or some other mechanism to keep the range up-to-date.
 *       On servers without highestmodseq, this will be null.
 *     }
 *     @key[updated DateMS]{
 *       What was our local timestamp the last time we synchronized this range?
 *       This is speculative and probably just for debugging unless we have the
 *       UI reflect that in offline mode it knows what it is showing you could
 *       be fairly out of date.
 *     }
 *   }
 *   ]]{
 *     Did we fully synchronize this time range (because of a date scan)?  If
 *     false, the implication is that we know about the messages in this range
 *     because of some type of search.
 *   }
 * ]]{
 *   Describes the provenance of the data we have for a given time range.
 *   Tracked independently of the block data because there doesn't really seem
 *   to be an upside to coupling them.  The date ranges are inclusive; other
 *   blocks should differ by at least 1 millisecond.
 *
 *   This lets us know when we have sufficiently valid data to display messages
 *   without needing to talk to the server, allows us to size checks for
 *   new messages in time ranges, and should be a useful debugging aid.
 * }
 * @typedef[FolderBlockInfo @dict[
 *   @key[blockId BlockId]{
 *     The name of the block for storage access.
 *   }
 *   @key[startTS DateMS]{
 *     The timestamp of the last and therefore (possibly equally) oldest message
 *     in this block.  Forms the first part of a composite key with `startUID`.
 *   }
 *   @key[startUID UID]{
 *     The UID of the last and therefore (possibly equally) oldest message
 *     in this block.  Forms the second part of a composite key with `startTS`.
 *   }
 *   @key[endTS DateMS]{
 *     The timestamp of the first and therefore (possibly equally) newest
 *     message in this block.  Forms the first part of a composite key with
 *     `endUID`.
 *   }
 *   @key[endUID UID]{
 *     The UID of the first and therefore (possibly equally) newest message
 *     in this block.  Forms the second part of a composite key with `endTS`.
 *   }
 *   @key[count Number]{
 *     The number of messages in this bucket.
 *   }
 *   @key[estSize Number]{
 *     The estimated size in bytes all of the messages in this bucket use.  This
 *     is to assist us in known when to split/merge blocks.
 *   }
 * ]]{
 *   The directory entries for our `HeaderBlock` and `BodyBlock` instances.
 *   Currently, these are always stored in memory since they are small and
 *   there shouldn't be a tremendous number of them.
 *
 *   These
 * }
 * @typedef[EmailAddress String]
 * @typedef[NameAddressPair @dict[
 *   @key[address EmailAddress]
 *   @key[name String]
 * ]]
 * @typedef[HeaderInfo @dict[
 *   @key[id]{
 *     Either the UID or a more globally unique identifier (Gmail).
 *   }
 *   @key[suid]{
 *     The id prefixed with the folder id and a dash.
 *   }
 *   @key[author NameAddressPair]
 *   @key[date DateMS]
 *   @key[flags @listof[String]]
 *   @key[hasAttachments Boolean]
 *   @key[subject String]
 *   @key[snippet String]
 * ]]
 * @typedef[HeaderBlock @dict[
 *   @key[uids @listof[UID]]{
 *     The UIDs of the headers in the same order.  This is intended as a fast
 *     parallel search mechanism.  It can be discarded if it doesn't prove
 *     useful.
 *   }
 *   @key[headers @listof[HeaderInfo]]{
 *     Headers in numerically decreasing time and UID order.  The header at
 *     index 0 should correspond to the 'end' characteristics of the blockInfo
 *     and the header at n-1 should correspond to the start characteristics.
 *   }
 * ]]
 * @typedef[AttachmentInfo @dict[
 *   @key[filename String]
 *   @key[mimetype String]
 *   @key[size Number]{
 *     Estimated file size in bytes.
 *   }
 * ]]
 * @typedef[BodyInfo @dict[
 *   @key[date DateMS]{
 *     Redundantly stored date info for block splitting purposes.  We pretty
 *     much need this no matter what because our ordering is on the tuples of
 *     dates and UIDs, so we could have trouble efficiently locating our header
 *     from the body without this.
 *   }
 *   @key[size Number]
 *   @key[to @listof[NameAddressPair]]
 *   @key[cc @listof[NameAddressPair]]
 *   @key[bcc @listof[NameAddressPair]]
 *   @key[replyTo EmailAddress]
 *   @key[attachments @listof[AttachmentInfo]]
 *   @key[bodyText String]{
 *     The text of the message body.
 *   }
 * ]]{
 *   Information on the message body that is only for full message display.
 *   The to/cc/bcc information may get moved up to the header in the future,
 *   but our driving UI doesn't need it right now.
 * }
 * @typedef[BodyBlock @dict[
 *   @key[uids @listof[UID]]
 *   @key[bodies @dictof[
 *     @key["unique identifier" UID]
 *     @value[BodyInfo]
 *   ]]
 * ]]
 */
function ImapFolderStorage(account, folderId, persistedFolderInfo, dbConn,
                           _parentLog) {
  /** Our owning account. */
  this._account = account;
  this._imapDb = dbConn;

  this.folderId = folderId;
  this.folderMeta = persistedFolderInfo.$meta;
  this._folderImpl = persistedFolderInfo.$impl;

  this._LOG = LOGFAB.ImapFolderStorage(
    this, _parentLog, folderId);

  /**
   * @listof[AccuracyRangeInfo]{
   *   Newest-to-oldest sorted list of accuracy range info structures that are
   *   keyed by their IMAP-consistent startTS (inclusive) and endTS (exclusive)
   *   on a per-day granularity.
   * }
   */
  this._accuracyRanges = persistedFolderInfo.accuracy;
  /**
   * @listof[FolderBlockInfo]{
   *   Newest-to-oldest (numerically decreasing time and UID) sorted list of
   *   header folder block infos.  They are keyed by a composite key consisting
   *   of messages' "date" and "id" fields.
   * }
   */
  this._headerBlockInfos = persistedFolderInfo.headerBlocks;
  /**
   * @listof[FolderBlockInfo]{
   *   Newest-to-oldest (numerically decreasing time and UID) sorted list of
   *   body folder block infos.  They are keyed by a composite key consisting
   *   of messages' "date" and "id" fields.
   * }
   */
  this._bodyBlockInfos = persistedFolderInfo.bodyBlocks;

  /** @dictof[@key[BlockId] @value[HeaderBlock]] */
  this._headerBlocks = {};
  /** @dictof[@key[BlockId] @value[BodyBlock]] */
  this._bodyBlocks = {};

  this._bound_makeHeaderBlock = this._makeHeaderBlock.bind(this);
  this._bound_insertHeaderInBlock = this._insertHeaderInBlock.bind(this);
  this._bound_splitHeaderBlock = this._splitHeaderBlock.bind(this);
  this._bound_deleteHeaderFromBlock = this._deleteHeaderFromBlock.bind(this);

  this._bound_makeBodyBlock = this._makeBodyBlock.bind(this);
  this._bound_insertBodyInBlock = this._insertBodyInBlock.bind(this);
  this._bound_splitBodyBlock = this._splitBodyBlock.bind(this);
  this._bound_deleteBodyFromBlock = this._deleteBodyFromBlock.bind(this);

  /**
   * Has our internal state altered at all and will need to be persisted?
   */
  this._dirty = false;
  /** @dictof[@key[BlockId] @value[HeaderBlock]] */
  this._dirtyHeaderBlocks = {};
  /** @dictof[@key[BlockId] @value[BodyBlock]] */
  this._dirtyBodyBlocks = {};

  /**
   * @listof[AggrBlockId]
   */
  this._pendingLoads = [];
  /**
   * @dictof[
   *   @key[AggrBlockId]
   *   @key[@listof[@func]]
   * ]
   */
  this._pendingLoadListeners = {};

  /**
   * @listof[@func[]]{
   *   A list of fully-bound functions to drain when the last pending load gets
   *   loaded, at least until a new load goes pending.
   * }
   */
  this._deferredCalls = [];

  /**
   * The number of pending mutation requests on the folder; currently because
   * of how mutation operations are scheduled, this will either be 0 or 1.
   * This will probably still remain true in the future, but we will adopt a
   * connection reclaimation strategy so we don't keep jumping into and out of
   * the same folder.
   */
  this._pendingMutationCount = 0;

  /**
   * Active view slices on this folder.
   */
  this._slices = [];
  /**
   * The slice that is driving our current synchronization and wants to hear
   * about all header modifications/notes as they occur.
   */
  this._curSyncSlice = null;
  /**
   * The start range of the (backward-moving) sync time range.
   */
  this._curSyncStartTS = null;

  this.folderConn = new ImapFolderConn(account, this, this._LOG);
}
exports.ImapFolderStorage = ImapFolderStorage;
ImapFolderStorage.prototype = {
  generatePersistenceInfo: function() {
    if (!this._dirty)
      return null;
    var pinfo = {
      id: this.folderId,
      headerBlocks: this._dirtyHeaderBlocks,
      bodyBlocks: this._dirtyBodyBlocks,
    };
    this._dirtyHeaderBlocks = {};
    this._dirtyBodyBlocks = {};
    this._dirty = false;
    return pinfo;
  },

  /**
   * Create an empty header `FolderBlockInfo` and matching `HeaderBlock`.  The
   * `HeaderBlock` will be inserted into the block map, but it's up to the
   * caller to insert the returned `FolderBlockInfo` in the right place.
   */
  _makeHeaderBlock: function ifs__makeHeaderBlock(
      startTS, startUID, endTS, endUID, estSize, uids, headers) {
    var blockId = $a64.encodeInt(this._folderImpl.nextHeaderBlock++),
        blockInfo = {
          blockId: blockId,
          startTS: startTS,
          startUID: startUID,
          endTS: endTS,
          endUID: endUID,
          count: uids ? uids.length : 0,
          estSize: estSize || 0,
        },
        block = {
          uids: uids || [],
          headers: headers || [],
        };
    this._dirty = true;
    this._headerBlocks[blockId] = block;
    this._dirtyHeaderBlocks[blockId] = block;
    return blockInfo;
  },

  _insertHeaderInBlock: function ifs__insertHeaderInBlock(header, uid, info,
                                                          block) {
    var idx = bsearchForInsert(block.headers, header, cmpHeaderYoungToOld);
    block.uids.splice(idx, 0, header.id);
    block.headers.splice(idx, 0, header);
    this._dirty = true;
    this._dirtyHeaderBlocks[info.blockId] = block;
    // Insertion does not need to update start/end TS/UID because the calling
    // logic is able to handle it.
  },

  _deleteHeaderFromBlock: function ifs__deleteHeaderFromBlock(uid, info, block) {
    var idx = block.uids.indexOf(uid), header;
    // - remove, update counts
    block.uids.splice(idx, 1);
    block.headers.splice(idx, 1);
    info.estSize -= HEADER_EST_SIZE_IN_BYTES;
    info.count--;
    // - update endTS/endUID if necessary
    if (idx === 0 && info.count) {
      header = block.headers[0];
      info.endTS = header.date;
      info.endUID = header.id;
    }
    // - update startTS/startUID if necessary
    if (idx === info.count && idx > 0) {
      header = block.headers[idx - 1];
      info.startTS = header.date;
      info.startUID = header.id;
    }
  },

  /**
   * Split the contents of the given header block into a newer and older block.
   * The newer info block will be mutated in place; the older block info will
   * be created and returned.  The newer block is filled with data until it
   * first overflows newerTargetBytes.  This method is responsible for updating
   * the actual containing blocks as well.
   */
  _splitHeaderBlock: function ifs__splitHeaderBlock(splinfo, splock,
                                                    newerTargetBytes) {
    // We currently assume a fixed size, so this is easy.
    var numHeaders = Math.ceil(newerTargetBytes / HEADER_EST_SIZE_IN_BYTES);
    if (numHeaders > splock.headers.length)
      throw new Error("No need to split!");

    var olderNumHeaders = splock.headers.length - numHeaders,
        olderEndHeader = splock.headers[numHeaders],
        olderInfo = this._makeHeaderBlock(
                      // Take the start info from the block, because it may have
                      // been extended beyond the header (for an insertion if
                      // we change back to inserting after splitting.)
                      splinfo.startTS, splinfo.startUID,
                      olderEndHeader.date, olderEndHeader.id,
                      olderNumHeaders * HEADER_EST_SIZE_IN_BYTES,
                      splock.uids.splice(numHeaders, olderNumHeaders),
                      splock.headers.splice(numHeaders, olderNumHeaders));

    var newerStartHeader = splock.headers[numHeaders - 1];
    splinfo.count = numHeaders;
    splinfo.estSize = numHeaders * HEADER_EST_SIZE_IN_BYTES;
    splinfo.startTS = newerStartHeader.date;
    splinfo.startUID = newerStartHeader.id;

    return olderInfo;
  },

  /**
   * Create an empty header `FolderBlockInfo` and matching `BodyBlock`.  The
   * `BodyBlock` will be inserted into the block map, but it's up to the
   * caller to insert the returned `FolderBlockInfo` in the right place.
   */
  _makeBodyBlock: function ifs__makeBodyBlock(
      startTS, startUID, endTS, endUID, size, uids, bodies) {
    var blockId = $a64.encodeInt(this._folderImpl.nextBodyBlock++),
        blockInfo = {
          blockId: blockId,
          startTS: startTS,
          startUID: startUID,
          endTS: endTS,
          endUID: endUID,
          count: uids ? uids.length : 0,
          estSize: size || 0,
        },
        block = {
          uids: uids || [],
          bodies: bodies || {},
        };
    this._dirty = true;
    this._bodyBlocks[blockId] = block;
    this._dirtyBodyBlocks[blockId] = block;
    return blockInfo;
  },

  _insertBodyInBlock: function ifs__insertBodyInBlock(body, uid, info, block) {
    function cmpBodyByUID(aUID, bUID) {
      var aDate = (aUID === uid) ? body.date : block.bodies[aUID].date,
          bDate = (bUID === uid) ? body.date : block.bodies[bUID].date,
          d = bDate - aDate;
      if (d)
        return d;
      d = bUID - aUID;
      return d;
    }

    var idx = bsearchForInsert(block.uids, uid, cmpBodyByUID);
    block.uids.splice(idx, 0, uid);
    block.bodies[uid] = body;
    this._dirty = true;
    this._dirtyBodyBlocks[info.blockId] = block;
    // Insertion does not need to update start/end TS/UID because the calling
    // logic is able to handle it.
  },

  _deleteBodyFromBlock: function ifs__deleteBodyFromBlock(uid, info, block) {
    // - delete
    var idx = block.uids.indexOf(uid);
    block.uids.splice(idx, 1);
    var body = block.bodies[uid];
    delete block.bodies[uid];
    info.estSize -= body.size;
    info.count--;

    // - update endTS/endUID if necessary
    if (idx === 0 && info.count) {
      info.endUID = uid = block.uids[0];
      info.endTS = block.bodies[uid].date;
    }
    // - update startTS/startUID if necessary
    if (idx === info.count && idx > 0) {
      info.startUID = uid = block.uids[idx - 1];
      info.startTS = block.bodies[uid].date;
    }
  },

  _splitBodyBlock: function ifs__splitBodyBlock(splinfo, splock,
                                                newerTargetBytes) {
    // Save off the start timestamp/uid; these may have been extended beyond the
    // delimiting bodies because of the insertion triggering the split.  (At
    // least if we start inserting after splitting again in the future.)
    var savedStartTS = splinfo.startTS, savedStartUID = splinfo.startUID;

    var newerBytes = 0, uids = splock.uids, newDict = {}, oldDict = {},
        inNew = true, numHeaders = null;
    for (var i = 0; i < uids.length; i++) {
      var uid = uids[i],
          body = splock.bodies[uid];
      if (inNew) {
        newerBytes += body.size;
        newDict[uid] = body;
        if (newerBytes >= newerTargetBytes) {
          inNew = false;
          splinfo.count = numHeaders = i + 1;
          splinfo.startTS = body.date;
          splinfo.startUID = uid;
        }
      }
      else {
        oldDict[uid] = body;
      }
    }

    var oldEndUID = uids[numHeaders];
    var olderInfo = this._makeBodyBlock(
      savedStartTS, savedStartUID,
      oldDict[oldEndUID].date, oldEndUID,
      splinfo.estSize - newerBytes,
      uids.splice(numHeaders, uids.length - numHeaders),
      oldDict);
    splinfo.estSize = newerBytes;
    splock.bodies = newDict;

    return olderInfo;
  },

  /**
   * Find the first object that contains date ranges whose date ranges contains
   * the provided date.  For use to find the right index in `_accuracyRanges`,
   * `_headerBlockInfos`, and `_bodyBlockInfos`, all of which are pre-sorted.
   *
   * @return[@list[
   *   @param[index Number]{
   *     The index of the Object that contains the date, or if there is no such
   *     structure, the index that it should be inserted at.
   *   }
   *   @param[inside Object]
   * ]]
   */
  _findRangeObjIndexForDate: function ifs__findRangeObjIndexForDate(
      list, date) {
    var i;
    // linear scan for now; binary search later
    for (i = 0; i < list.length; i++) {
      var info = list[i];
      // - Stop if we will never find a match if we keep going.
      // If our date is after the end of this range, then it will never fall
      // inside any subsequent ranges, because they are all chronologically
      // earlier than this range.
      if (SINCE(date, info.endTS))
        return [i, null];
      // therefore BEFORE(date, info.endTS)

      if (SINCE(date, info.startTS))
        return [i, info];
      // (Older than the startTS, keep going.)
    }

    return [i, null];
  },

  /**
   * Find the first object that contains date ranges whose date ranges contains
   * the provided composite date/UID.  For use to find the right index in
   * `_headerBlockInfos`, and `_bodyBlockInfos`, all of which are pre-sorted.
   *
   * @return[@list[
   *   @param[index Number]{
   *     The index of the Object that contains the date, or if there is no such
   *     structure, the index that it should be inserted at.
   *   }
   *   @param[inside Object]
   * ]]
   */
  _findRangeObjIndexForDateAndUID: function ifs__findRangeObjIndexForDateAndUID(
      list, date, uid) {
    var i;
    // linear scan for now; binary search later
    for (i = 0; i < list.length; i++) {
      var info = list[i];
      // - Stop if we will never find a match if we keep going.
      // If our date is after the end of this range, then it will never fall
      // inside any subsequent ranges, because they are all chronologically
      // earlier than this range.
      // If our date is the same and our UID is higher, then likewise we
      // shouldn't go further because UIDs decrease too.
      if (STRICTLY_AFTER(date, info.endTS) ||
          (date === info.endTS && uid > info.endUID))
        return [i, null];
      // therefore BEFORE(date, info.endTS) ||
      //           (date === info.endTS && uid <= info.endUID)

      if (STRICTLY_AFTER(date, info.startTS) ||
          (date === info.startTS && uid >= info.startUID))
        return [i, info];
      // (Older than the startTS, keep going.)
    }
    return [i, null];
  },


  /**
   * Find the first object that contains date ranges that overlaps the provided
   * date range.  Scans from the present into the past.
   */
  _findFirstObjIndexForDateRange: function ifs__findFirstObjIndexForDateRange(
      list, startTS, endTS) {
    var i;
    // linear scan for now; binary search later
    for (i = 0; i < list.length; i++) {
      var info = list[i];
      // - Stop if we will never find a match if we keep going.
      // If our comparison range starts AT OR AFTER the end of this range, then
      // it does not overlap this range and will never overlap any subsequent
      // ranges because they are all chronologically earlier than this range.
      //
      // nb: We are saying that there is no overlap if one range starts where
      // the other one ends.  This is consistent with the inclusive/exclusive
      // definition of since/before and our ranges.
      if (SINCE(startTS, info.endTS))
        return [i, null];
      // therefore BEFORE(startTS, info.endTS)

      // nb: SINCE(endTS, info.startTS) is not right here because the equals
      // case does not result in overlap because endTS is exclusive.
      if (STRICTLY_AFTER(endTS, info.startTS))
        return [i, info];

      // (no overlap yet)
    }

    return [i, null];
  },

  /**
   * Find the last object that contains date ranges that overlaps the provided
   * date range.  Scans from the past into the present.
   */
  _findLastObjIndexForDateRange: function ifs__findLastObjIndexForDateRange(
      list, startTS, endTS) {
    var i;
    // linear scan for now; binary search later
    for (i = list.length - 1; i >= 0; i--) {
      var info = list[i];
      // - Stop if we will never find a match if we keep going.
      // If our comparison range ends ON OR BEFORE the end of this range, then
      // it does not overlap this range and will never overlap any subsequent
      // ranges because they are all chronologically later than this range.
      //
      // nb: We are saying that there is no overlap if one range starts where
      // the other one ends.  This is consistent with the inclusive/exclusive
      // definition of since/before and our ranges.
      if (ON_OR_BEFORE(endTS, info.startTS))
        return [i + 1, null];
      // therefore STRICTLY_AFTER(endTS, info.startTS)

      // we match in this entry if the start stamp is before the range's end
      if (BEFORE(startTS, info.endTS))
        return [i, info];

      // (no overlap yet)
    }

    return [0, null];
  },


  /**
   * Find the first object in the list whose `date` falls inside the given
   * IMAP style date range.
   */
  _findFirstObjForDateRange: function ifs__findFirstObjForDateRange(
      list, startTS, endTS) {
    var i;
    for (i = 0; i < list.length; i++) {
      var date = list[i].date;
      if (IN_BS_DATE_RANGE(date, startTS, endTS))
        return [i, list[i]];
    }
    return [i, null];
  },

  /**
   * Find the right block to insert a header/body into using its date and UID.
   * This is an asynchronous operation because we potentially need to load
   * blocks from disk.
   *
   * == Usage patterns
   *
   * - In initial-sync cases and scrolling down through the list, we will
   *   generate messages from a younger-to-older direction.  The insertion point
   *   will then likely occur after the last block.
   * - In update-sync cases, we should be primarily dealing with new mail which
   *   is still retrieved endTS to startTS.  The insertion point will start
   *   before the first block and then move backwards within that block.
   * - Update-sync cases may also encounter messages moved into the folder
   *   from other folders since the last sync.  An archive folder is the
   *   most likely case for this, and we would expect random additions with a
   *   high degree of clustering on message date.
   * - Update-sync cases may experience a lot of apparent message deletion due
   *   to actual deletion or moves to other folders.  These can shrink blocks
   *   and we need to consider block merges to avoid pathological behavior.
   * - Forgetting messages that are no longer being kept alive by sync settings
   *   or apparent user interest.  There's no benefit to churn for the sake of
   *   churn, so we can just forget messages in blocks wholesale when we
   *   experience disk space pressure (from ourselves or elsewhere).  In that
   *   case we will want to traverse from the startTS messages, dropping them and
   *   consolidating blocks as we go until we have freed up enough space.
   *
   * == General strategy
   *
   * - If we fall in an existing block and it won't overflow, use it.
   * - If we fall in an existing block and it would overflow, split it.
   * - If we fall outside existing blocks, check older and newer blocks in that
   *   order for a non-overflow fit.  If we would overflow, pick the existing
   *   block further from the center to perform a split.
   * - If there are no existing blocks at all, create a new one.
   * - When splitting, if we are the first or last block, split 2/3 towards the
   *   center and 1/3 towards the edge.  The idea is that growth is most likely
   *   to occur near the edges, so concentrate the empty space there without
   *   leaving the center blocks so overloaded they can't accept random
   *   additions without further splits.
   * - When splitting, otherwise, split equally-ish.
   *
   * == Block I/O
   *
   * While we can make decisions about where to insert things, we need to have
   * blocks in memory in order to perform the actual splits.  The outcome
   * of splits can't be predicted because the size of things in blocks is
   * only known when the block is loaded.
   *
   * @args[
   *   @param[type @oneof['header' 'body']]
   *   @param[date DateMS]
   *   @param[estSizeCost Number]{
   *     The rough byte cost of whatever we want to stick in a block.
   *   }
   *   @param[thing Object]
   *   @param[blockPickedCallback @func[
   *     @args[
   *       @param[blockInfo FolderBlockInfo]
   *       @param[block @oneof[HeaderBlock BodyBlock]]
   *     ]
   *   ]]{
   *     Callback function to invoke once we have found/created/made-room-for
   *     the thing in the block.  This needs to be a callback because if we need
   *     to perform any splits, we require that the block be loaded into memory
   *     first.  (For consistency and simplicity, we then made us always return
   *     the block.)
   *   }
   * ]
   */
  _insertIntoBlockUsingDateAndUID: function ifs__pickInsertionBlocks(
      type, date, uid, estSizeCost, thing, blockPickedCallback) {
    var blockInfoList, blockMap, makeBlock, insertInBlock, splitBlock;
    if (type === 'header') {
      blockInfoList = this._headerBlockInfos;
      blockMap = this._headerBlocks;
      makeBlock = this._bound_makeHeaderBlock;
      insertInBlock = this._bound_insertHeaderInBlock;
      splitBlock = this._bound_splitHeaderBlock;
    }
    else {
      blockInfoList = this._bodyBlockInfos;
      blockMap = this._bodyBlocks;
      makeBlock = this._bound_makeBodyBlock;
      insertInBlock = this._bound_insertBodyInBlock;
      splitBlock = this._bound_splitBodyBlock;
    }

    // -- find the current containing block / insertion point
    var infoTuple = this._findRangeObjIndexForDateAndUID(blockInfoList,
                                                         date, uid),
        iInfo = infoTuple[0], info = infoTuple[1];

    // -- not in a block, find or create one
    if (!info) {
      // - Create a block if no blocks exist at all.
      if (blockInfoList.length === 0) {
        info = makeBlock(date, uid, date, uid);
        blockInfoList.splice(iInfo, 0, info);
      }
      // - Is there a trailing/older dude and we fit?
      else if (iInfo < blockInfoList.length &&
               blockInfoList[iInfo].estSize + estSizeCost < MAX_BLOCK_SIZE) {
        info = blockInfoList[iInfo];

        // We are chronologically/UID-ically more recent, so check the end range
        // for expansion needs.
        if (STRICTLY_AFTER(date, info.endTS)) {
          info.endTS = date;
          info.endUID = uid;
        }
        else if (date === info.endTS &&
                 uid > info.endUID) {
          info.endUID = uid;
        }
      }
      // - Is there a preceding/younger dude and we fit?
      else if (iInfo > 0 &&
               blockInfoList[iInfo - 1].estSize + estSizeCost < MAX_BLOCK_SIZE){
        info = blockInfoList[--iInfo];

        // We are chronologically less recent, so check the start range for
        // expansion needs.
        if (BEFORE(date, info.startTS)) {
          info.startTS = date;
          info.startUID = uid;
        }
        else if (date === info.startTS &&
                 uid < info.startUID) {
          info.startUID = uid;
        }
      }
      // Any adjacent blocks at this point are overflowing, so it's now a
      // question of who to split.  We pick the one further from the center that
      // exists.
      // - Preceding (if possible and) suitable OR the only choice
      else if ((iInfo > 0 && iInfo < blockInfoList.length / 2) ||
               (iInfo === blockInfoList.length)) {
        info = blockInfoList[--iInfo];
        // We are chronologically less recent, so check the start range for
        // expansion needs.
        if (BEFORE(date, info.startTS)) {
          info.startTS = date;
          info.startUID = uid;
        }
        else if (date === info.startTS &&
                 uid < info.startUID) {
          info.startUID = uid;
        }
      }
      // - It must be the trailing dude
      else {
        info = blockInfoList[iInfo];
        // We are chronologically/UID-ically more recent, so check the end range
        // for expansion needs.
        if (STRICTLY_AFTER(date, info.endTS)) {
          info.endTS = date;
          info.endUID = uid;
        }
        else if (date === info.endTS &&
                 uid > info.endUID) {
          info.endUID = uid;
        }
      }
    }
    // (info now definitely exists and is definitely in blockInfoList)

    function processBlock(block) { // 'this' gets explicitly bound
      // -- perform the insertion
      // We could do this after the split, but this makes things simpler if
      // we want to factor in the newly inserted thing's size in the
      // distribution of bytes.
      info.estSize += estSizeCost;
      info.count++;
      insertInBlock(thing, uid, info, block);

      // -- split if necessary
      if (info.estSize >= MAX_BLOCK_SIZE) {
        // - figure the desired resulting sizes
        var firstBlockTarget;
        // big part to the center at the edges (favoring front edge)
        if (iInfo === 0)
          firstBlockTarget = BLOCK_SPLIT_SMALL_PART;
        else if (iInfo === blockInfoList.length - 1)
          firstBlockTarget = BLOCK_SPLIT_LARGE_PART;
        // otherwise equal split
        else
          firstBlockTarget = BLOCK_SPLIT_EQUAL_PART;


        // - split
        var olderInfo;
        olderInfo = splitBlock(info, block, firstBlockTarget);
        blockInfoList.splice(iInfo + 1, 0, olderInfo);

        // - figure which of the blocks our insertion went in
        if (BEFORE(date, olderInfo.endTS) ||
            ((date === olderInfo.endTS) && (uid <= olderInfo.endUID))) {
          iInfo++;
          info = olderInfo;
          block = blockMap[info.blockId];
        }
      }
      // otherwise, no split necessary, just use it

      if (blockPickedCallback)
        blockPickedCallback(info, block);
    }

    if (blockMap.hasOwnProperty(info.blockId))
      processBlock.call(this, blockMap[info.blockId]);
    else
      this._loadBlock(type, info.blockId, processBlock.bind(this));
  },

  /**
   * Request the load of the given block and the invocation of the callback with
   * the block when the load completes.
   */
  _loadBlock: function ifs__loadBlock(type, blockId, callback) {
    if (blockId == null)
      throw new Error('Bad block id!');
    var aggrId = type + blockId;
    if (this._pendingLoads.indexOf(aggrId) !== -1) {
      this._pendingLoadListeners[aggrId].push(callback);
      return;
    }

    var index = this._pendingLoads.length;
    this._pendingLoads.push(aggrId);
    this._pendingLoadListeners[aggrId] = [callback];

    var self = this;
    function onLoaded(block) {
      if (!block)
        self._LOG.badBlockLoad(type, blockId);
      self._LOG.loadBlock_end(type, blockId, block);
      if (type === 'header')
        self._headerBlocks[blockId] = block;
      else
        self._bodyBlocks[blockId] = block;
      self._pendingLoads.splice(self._pendingLoads.indexOf(aggrId), 1);
      var listeners = self._pendingLoadListeners[aggrId];
      delete self._pendingLoadListeners[aggrId];
      for (var i = 0; i < listeners.length; i++) {
        listeners[i](block);
      }
    }

    this._LOG.loadBlock_begin(type, blockId);
    if (type === 'header')
      this._imapDb.loadHeaderBlock(this.folderId, blockId, onLoaded);
    else
      this._imapDb.loadBodyBlock(this.folderId, blockId, onLoaded);
  },

  _deleteFromBlock: function ifs__deleteFromBlock(type, date, uid, callback) {
    var blockInfoList, blockMap, deleteFromBlock;
    if (type === 'header') {
      blockInfoList = this._headerBlockInfos;
      blockMap = this._headerBlocks;
      deleteFromBlock = this._bound_deleteHeaderFromBlock;
    }
    else {
      blockInfoList = this._bodyBlockInfos;
      blockMap = this._bodyBlocks;
      deleteFromBlock = this._bound_deleteBodyFromBlock;
    }

    var infoTuple = this._findRangeObjIndexForDateAndUID(blockInfoList,
                                                         date, uid),
        iInfo = infoTuple[0], info = infoTuple[1];
    // If someone is asking for us to delete something, there should definitely
    // be a block that includes it!
    if (!info) {
      console.warn('Unable to find block that owns:', type, date, uid);
      return;
    }

    function processBlock(block) {
      // The delete function is in charge of updating the start/end TS/UID info
      // because it knows about the internal block structure to do so.
      deleteFromBlock(uid, info, block);

      // - Nuke the block if it's empty
      if (info.count === 0) {
        blockInfoList.splice(iInfo, 1);
        delete blockMap[info.blockId];

        this._dirty = true;
        if (type === 'header')
          this._dirtyHeaderBlocks[info.blockId] = null;
        else
          this._dirtyBodyBlocks[info.blockId] = null;
      }

      if (callback)
        callback();
    }
    if (blockMap.hasOwnProperty(info.blockId))
      processBlock.call(this, blockMap[info.blockId]);
    else
      this._loadBlock(type, info.blockId, processBlock.bind(this));
  },

  /**
   * Track a new slice that wants to start from 'now'.  We will provide it with
   * messages once we have a "sufficiently recent" set of data on the messages.
   *
   * We will tell the slice about what we know about immediately (and without
   * waiting for the server) if we are offline or the data we have is fairly
   * recent.  We will wait for sync if we have no data or we believe we have
   * network and are sufficiently out-of-date that what we show the user would
   * be useless.
   */
  sliceOpenFromNow: function ifs_sliceOpenFromNow(slice, daysDesired) {
    daysDesired = daysDesired || INITIAL_SYNC_DAYS;
    this._slices.push(slice);
    if (this._curSyncSlice) {
      console.error("Trying to open a slice and initiate a sync when there",
                    "is already an active sync slice!");
    }

    // -- Check if we have sufficiently useful data on hand.

    var now = TIME_WARPED_NOW || Date.now(),
        futureNow = FUTURE_TIME_WARPED_NOW || null,
        pastDate = makeDaysAgo(daysDesired),
        iAcc, iHeadBlock, ainfo,
        // What is the startTS fullSync data we have for the time range?
        worstGoodData = 0;

    for (iAcc = 0; iAcc < this._accuracyRanges.length; i++) {
      ainfo = this._accuracyRanges[iAcc];
      if (BEFORE(pastDate, ainfo.endTS))
        break;
      if (!ainfo.fullSync)
        break;
      if (worstGoodData)
        worstGoodData = Math.min(ainfo.fullSync.updated, worstGoodData);
      else
        worstGoodData = ainfo.fullSync.updated;
    }
    var existingDataGood;
    if (!this._account.universe.online)
      existingDataGood = true;
    else // TODO: consider just filling from the db if recent enough
      //existingDataGood = (worstGoodData + RECENT_ENOUGH_TIME_THRESH > now);
      existingDataGood = false;

    // -- Good existing data, fill the slice from the DB
    if (existingDataGood) {
      // We can adjust our start time to the dawn of time since we have a
      // limit in effect.
      slice.waitingOnData = 'db';
      this.getMessagesInDateRange(0, futureNow, INITIAL_FILL_SIZE,
                                  this.onFetchDBHeaders.bind(this, slice));
      return;
    }

    // -- Bad existing data, issue a sync and have the slice
    slice.setStatus('synchronizing');
    slice.waitingOnData = 'sync';
    this._curSyncSlice = slice;
    this._curSyncStartTS = pastDate;
    this.folderConn.syncDateRange(pastDate, futureNow, true,
                                  this.onSyncCompleted.bind(this));
  },

  refreshSlice: function ifs_refreshSlice(slice) {
    var startTS = slice.startTS, endTS = slice.endTS;
    // If the endTS lines up with the most recent know message for the folder,
    // then remove the timestamp constraint so it goes all the way to now.
    if (this._headerBlockInfos.length &&
        endTS === this._headerBlockInfos[0].endTS &&
        slice.endUID === this._headerBlockInfos[0].endUID) {
      endTS = FUTURE_TIME_WARPED_NOW || null;
    }
    else {
      // We want the range to include the day; since it's an exclusive range
      // quantized to midnight, we need to adjust forward a day and then
      // quantize.
      endTS = quantizeDate(endTS - DAY_MILLIS);
    }
    // XXX use mutex scheduling to avoid this possibly happening...
    if (this._curSyncSlice)
      throw new Error("Can't refresh a slice when there is an existing sync");
    this.folderConn.syncDateRange(startTS, endTS, true, function() {
      slice.setStatus('synced');
    });
  },

  dyingSlice: function ifs_dyingSlice(slice) {
    var idx = this._slices.indexOf(slice);
    this._slices.splice(idx, 1);

    if (this._slices.length === 0 && this._pendingMutationCount === 0)
      this.folderConn.relinquishConn();
  },

  /**
   * Whatever synchronization we last triggered has now completed; we should
   * either trigger another sync if we still want more data, or close out the
   * current sync.
   */
  onSyncCompleted: function ifs_onSyncCompleted() {
    console.log("Sync Completed!");
    // If the slice already knows about all the messages in the folder, make
    // sure it doesn't want additional messages that don't exist.
    if (this.folderConn && this.folderConn.box &&
        (this._curSyncSlice.desiredHeaders >
         this.folderConn.box.messages.total))
      this._curSyncSlice.desiredHeaders = this.folderConn.box.messages.total;

    // - Done if we don't want any more headers.
    // XXX prefetch may need a different success heuristic
    if ((this._curSyncSlice.headers.length >=
         this._curSyncSlice.desiredHeaders)) {
      console.log("SYNCDONE Enough headers retrieved.");
      this._curSyncSlice.waitingOnData = false;
      this._curSyncSlice.setStatus('synced');
      this._curSyncSlice = null;
      return;
    }

    // - Move the time range back in time more.
    var startTS = makeDaysBefore(this._curSyncStartTS, INCREMENTAL_SYNC_DAYS),
        endTS = this._curSyncStartTS;
    this._curSyncStartTS = startTS;
    this.folderConn.syncDateRange(startTS, endTS, true,
                                  this.onSyncCompleted.bind(this));
  },

  /**
   * Receive messages directly from the database.
   */
  onFetchDBHeaders: function(slice, headers, moreMessagesComing) {
    if (headers.length)
      slice.batchAppendHeaders(headers, moreMessagesComing);
    else if (!moreMessagesComing)
      slice.setStatus('synced');

    if (!moreMessagesComing)
      slice.waitingOnData = false;
  },

  sliceQuicksearch: function ifs_sliceQuicksearch(slice, searchParams) {
  },

  /**
   * Retrieve the (ordered list) of messages covering a given IMAP-style date
   * range that we know about.  Messages are returned from newest to oldest.
   *
   * @args[
   *   @param[startTS DateMS]
   *   @param[endTS DateMS]
   *   @param[limit #:optional Number]
   *   @param[messageCallback @func[
   *     @args[
   *       @param[headers @listof[HeaderInfo]]
   *       @param[moreMessagesComing Boolean]]
   *     ]
   *   ]
   * ]
   */
  getMessagesInDateRange: function ifs_getMessagesInDateRange(
      startTS, endTS, limit, messageCallback) {
    var toFill = (limit != null) ? limit : TOO_MANY_MESSAGES, self = this,
        // header block info iteration
        iHeadBlockInfo = null, headBlockInfo;
    if (endTS == null)
      endTS = TIME_WARPED_NOW || Date.now(); // or just use a huge number?

    // find the first header block with the data we want (was destructuring)
    var headerPair = this._findFirstObjIndexForDateRange(this._headerBlockInfos,
                                                         startTS, endTS);
    iHeadBlockInfo = headerPair[0];
    headBlockInfo = headerPair[1];

    if (!headBlockInfo) {
      // no blocks equals no messages.
      messageCallback([], false);
      return;
    }

    function fetchMore() {
      while (true) {
        // - load the header block if required
        if (!self._headerBlocks.hasOwnProperty(headBlockInfo.blockId)) {
          self._loadBlock('header', headBlockInfo.blockId, fetchMore);
          return;
        }
        var headerBlock = self._headerBlocks[headBlockInfo.blockId];
        // - use up as many headers in the block as possible
        // (previously used destructuring, but we want uglifyjs to work)
        var headerTuple = self._findFirstObjForDateRange(
                            headerBlock.headers,
                            startTS, endTS),
            iFirstHeader = headerTuple[0], header = headerTuple[1];
        // aw man, no usable messages?!
        if (!header) {
          messageCallback([], false);
          return;
        }
        // (at least one usable message)

        var iHeader = iFirstHeader;
        for (; iHeader < headerBlock.headers.length; iHeader++) {
          header = headerBlock.headers[iHeader];
          if (BEFORE(header.date, startTS))
            break;
        }
        // (iHeader is pointing at the index of message we don't want)
        // There is no further processing to do if we bailed early.
        if (iHeader < headerBlock.headers.length)
          toFill = 0;
        else
          toFill -= iHeader - iFirstHeader;

        if (!toFill) {
        }
        // - There may be viable messages in the next block, check.
        else if (++iHeadBlockInfo >= self._headerBlockInfos.length) {
          // Nope, there are no more messages, nothing left to do.
          toFill = 0;
        }
        else {
          headBlockInfo = self._headerBlockInfos[iHeadBlockInfo];
          // We may not want to go back any farther
          if (AFTER(startTS, headBlockInfo.endTS))
            toFill = 0;
        }
        // generate the notifications fo what we did create
        messageCallback(headerBlock.headers.slice(iFirstHeader, iHeader),
                        Boolean(toFill));
        if (!toFill)
          return;
        // (there must be some overlap, keep going)
      }
    }

    fetchMore();
  },

  /**
   * Batch/non-streaming version of `getMessagesInDateRange`.
   *
   * @args[
   *   @param[allCallback @func[
   *     @args[
   *       @param[headers @listof[HeaderInfo]]
   *     ]
   *   ]
   * ]
   */
  getAllMessagesInDateRange: function ifs_getAllMessagesInDateRange(
      startTS, endTS, allCallback) {
    var allHeaders = null;
    function someMessages(headers, moreHeadersExpected) {
      if (allHeaders)
        allHeaders = allHeaders.concat(headers);
      else
        allHeaders = headers;
      if (!moreHeadersExpected)
        allCallback(allHeaders);
    }
    this.getMessagesInDateRange(startTS, endTS, null, someMessages);
  },

  /**
   * Mark a given time range as synchronized.
   *
   * @args[
   *   @param[startTS DateMS]
   *   @param[endTS DateMS]
   *   @param[modseq]
   *   @parma[updated DateMS]
   * ]
   */
  markSyncRange: function(startTS, endTS, modseq, updated) {
    // If our range was marked open-ended, it's really accurate through now.
    if (!endTS)
      endTS = Date.now();
    var aranges = this._accuracyRanges;
    function makeRange(start, end, modseq, updated) {
      return {
        startTS: start, endTS: end,
        // let an existing fullSync be passed in instead...
        fullSync: (typeof(modseq) === 'string') ?
          { highestModseq: modseq, updated: updated } :
          { highestModseq: modseq.fullSync.highestModseq,
            updated: modseq.fullSync.updated },
      };
    }

    var newInfo = this._findFirstObjIndexForDateRange(aranges, startTS, endTS),
        oldInfo = this._findLastObjIndexForDateRange(aranges, startTS, endTS),
        newSplits, oldSplits;
    // We need to split the new block if we overlap a block and our end range
    // is not 'outside' the range.
    newSplits = newInfo[1] && STRICTLY_AFTER(newInfo[1].endTS, endTS);
    // We need to split the old block if we overlap a block and our start range
    // is not 'outside' the range.
    oldSplits = oldInfo[1] && BEFORE(oldInfo[1].startTS, startTS);

    var insertions = [],
        delCount = oldInfo[0] - newInfo[0];
    if (oldInfo[1])
      delCount++;

    if (newSplits) {
      // should this just be an effective merge with our insertion?
      if (newInfo[1].fullSync &&
          newInfo[1].fullSync.highestModseq === modseq &&
          newInfo[1].fullSync.updated === updated)
        endTS = newInfo[1].endTS;
      else
        insertions.push(makeRange(endTS, newInfo[1].endTS, newInfo[1]));
    }
    insertions.push(makeRange(startTS, endTS, modseq, updated));
    if (oldSplits) {
      // should this just be an effective merge with what we just inserted?
      if (oldInfo[1].fullSync &&
          oldInfo[1].fullSync.highestModseq === modseq &&
          oldInfo[1].fullSync.updated === updated)
        insertions[insertions.length-1].startTS = oldInfo[1].startTS;
      else
        insertions.push(makeRange(oldInfo[1].startTS, startTS, oldInfo[1]));
    }

    // - merges
    // Consider a merge if there is an adjacent accuracy range in the given dir.
    var newNeighbor = newInfo[0] > 0 ? aranges[newInfo[0] - 1] : null,
        oldAdjust = oldInfo[1] ? 1 : 0,
        oldNeighbor = oldInfo[0] < (aranges.length - oldAdjust) ?
                        aranges[oldInfo[0] + oldAdjust] : null;
    // We merge if our starts and ends line up...
    if (newNeighbor &&
       insertions[0].endTS === newNeighbor.startTS &&
        newNeighbor.fullSync &&
        newNeighbor.fullSync.highestModseq === modseq &&
        newNeighbor.fullSync.updated === updated) {
      insertions[0].endTS = newNeighbor.endTS;
      newInfo[0]--;
      delCount++;
    }
    if (oldNeighbor &&
        insertions[insertions.length-1].startTS === oldNeighbor.endTS &&
        oldNeighbor.fullSync &&
        oldNeighbor.fullSync.highestModseq === modseq &&
        oldNeighbor.fullSync.updated === updated) {
      insertions[insertions.length-1].startTS = oldNeighbor.startTS;
      delCount++;
    }

    aranges.splice.apply(aranges, [newInfo[0], delCount].concat(insertions));
  },

  /**
   * Add a new message to the database, generating slice notifications.
   */
  addMessageHeader: function ifs_addMessageHeader(header) {
    var self = this;

    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.addMessageHeader.bind(this, header));
      return;
    }

    if (self._curSyncSlice)
      self._curSyncSlice.onHeaderAdded(header);

    this._insertIntoBlockUsingDateAndUID(
      'header', header.date, header.id, HEADER_EST_SIZE_IN_BYTES,
      header, null);
  },

  /**
   * Update an existing mesage header in the database, generating slice
   * notifications and dirtying its containing block to cause eventual database
   * writeback.
   *
   * A message header gets updated ONLY because of a change in its flags.  We
   * don't consider this change large enough to cause us to need to split a
   * block.
   *
   * This function can either be used to replace the header or to look it up
   * and then call a function to manipulate the header.
   */
  updateMessageHeader: function ifs_updateMessageHeader(date, uid, partOfSync,
                                                        headerOrMutationFunc) {
    // (While this method can complete synchronously, we want to maintain its
    // perceived ordering relative to those that cannot be.)
    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.updateMessageHeader.bind(
                                 this, date, uid, partOfSync,
                                 headerOrMutationFunc));
      return;
    }

    // We need to deal with the potential for the block having been discarded
    // from memory thanks to the potential asynchrony due to pending loads or
    // on the part of the caller.
    var infoTuple = this._findRangeObjIndexForDateAndUID(
                      this._headerBlockInfos, date, uid),
        iInfo = infoTuple[0], info = infoTuple[1], self = this;
    function doUpdateHeader(block) {
      var idx = block.uids.indexOf(uid), header;
      if (idx === -1)
        throw new Error("Failed to find UID " + uid + "!");
      if (headerOrMutationFunc instanceof Function) {
        // If it returns false it means that the header did not change and so
        // there is no need to mark anything dirty and we can leave without
        // notifying anyone.
        if (!headerOrMutationFunc((header = block.headers[idx])))
          return;
      }
      else
        header = block.headers[idx] = headerOrMutationFunc;
      self._dirty = true;
      self._dirtyHeaderBlocks[info.blockId] = block;

      if (partOfSync && self._curSyncSlice)
        self._curSyncSlice.onHeaderAdded(header);
      if (self._slices.length > (self._curSyncSlice ? 1 : 0)) {
        for (var iSlice = 0; iSlice < self._slices.length; iSlice++) {
          var slice = self._slices[iSlice];
          if (partOfSync && slice === self._curSyncSlice)
            continue;
          if (BEFORE(date, slice.startTS) ||
              STRICTLY_AFTER(date, slice.endTS))
            continue;
          if ((date === slice.startTS &&
               uid < slice.startUID) ||
              (date === slice.endTS &&
               uid > slice.endUID))
            continue;
          slice.onHeaderModified(header);
        }
      }
    }
    if (!this._headerBlocks.hasOwnProperty(info.blockId))
      this._loadBlock('header', info.blockId, doUpdateHeader);
    else
      doUpdateHeader(this._headerBlocks[info.blockId]);
  },

  /**
   * A notification that an existing header is still up-to-date.
   */
  unchangedMessageHeader: function ifs_unchangedMessageHeader(header) {
    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.unchangedMessageHeader.bind(this, header));
      return;
    }
    // (no block update required)
    if (this._curSyncSlice)
      this._curSyncSlice.onHeaderAdded(header);
  },

  deleteMessageHeaderAndBody: function(header) {
    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.deleteMessageHeader.bind(this, header));
      return;
    }

    if (this._curSyncSlice)
      this._curSyncSlice.onHeaderRemoved(header);
    if (this._slices.length > (this._curSyncSlice ? 1 : 0)) {
      for (var iSlice = 0; iSlice < this._slices.length; iSlice++) {
        var slice = this._slices[iSlice];
        if (slice === this._curSyncSlice)
          continue;
        if (BEFORE(header.date, slice.startTS) ||
            STRICTLY_AFTER(header.date, slice.endTS))
          continue;
        if ((header.date === slice.startTS &&
             header.id < slice.startUID) ||
            (header.date === slice.endTS &&
             header.id > slice.endUID))
          continue;
        slice.onHeaderRemoved(header);
      }
    }

    this._deleteFromBlock('header', header.date, header.id, null);
    this._deleteFromBlock('body', header.date, header.id, null);
  },

  /**
   *
   */
  addMessageBody: function ifs_addMessageBody(header, bodyInfo) {
    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.addMessageBody.bind(this, header,
                                                        bodyInfo));
      return;
    }

    this._insertIntoBlockUsingDateAndUID(
      'body', header.date, header.id, bodyInfo.size, bodyInfo, null);
  },

  getMessageBody: function ifs_getMessageBody(suid, date, callback) {
    var uid = suid.substring(suid.lastIndexOf('/') + 1),
        posInfo = this._findRangeObjIndexForDateAndUID(this._bodyBlockInfos,
                                                       date, uid);
    if (posInfo[1] === null) {
      this._LOG.bodyNotFound();
      callback(null);
      return;
    }
    var bodyBlockInfo = posInfo[1], self = this;
    if (!(this._bodyBlocks.hasOwnProperty(bodyBlockInfo.blockId))) {
      this._loadBlock('body', bodyBlockInfo.blockId, function(bodyBlock) {
          var bodyInfo = bodyBlock.bodies[uid] || null;
          if (!bodyInfo)
            self._LOG.bodyNotFound();
          callback(bodyInfo);
        });
      return;
    }
    var block = this._bodyBlocks[bodyBlockInfo.blockId],
        bodyInfo = block.bodies[uid] || null;
    if (!bodyInfo)
      this._LOG.bodyNotFound();
    callback(bodyInfo);
  },

  shutdown: function() {
    // reverse iterate since they will remove themselves as we kill them
    for (var i = this._slices.length - 1; i >= 0; i++) {
      this._slices[i].die();
    }
    this.folderConn.shutdown();
    this._LOG.__die();
  },

  /**
   * The folder is no longer known on the server or we are just deleting the
   * account; close out any live connections or processing.  Database cleanup
   * will be handled at the account level so it can go in a transaction with
   * all the other related changes.
   */
  youAreDeadCleanupAfterYourself: function() {
    // XXX close connections, etc.
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
  ImapSlice: {
    type: $log.QUERY,
    events: {
      headersAppended: {},
      headerAdded: { index: false },
      headerModified: { index: false },
      headerRemoved: { index: false },
    },
    TEST_ONLY_events: {
      headersAppended: { headers: false },
      headerAdded: { header: false },
      headerModified: { header: false },
      headerRemoved: { header: false },
    },
  },

  ImapFolderConn: {
    type: $log.CONNECTION,
    subtype: $log.CLIENT,
    events: {
    },
    TEST_ONLY_events: {
    },
    asyncJobs: {
      syncDateRange: {
        newMessages: true, existingMessages: true, deletedMessages: true,
        start: false, end: false,
      },
    },
  },

  ImapFolderStorage: {
    type: $log.DATABASE,
    events: {
      // This was an error but the test results viewer UI is not quite smart
      // enough to understand the difference between expected errors and
      // unexpected errors, so this is getting downgraded for now.
      bodyNotFound: {},
    },
    TEST_ONLY_events: {
    },
    asyncJobs: {
      loadBlock: { type: false, blockId: false },
    },
    TEST_ONLY_asyncJobs: {
      loadBlock: { block: false },
    },
    errors: {
      badBlockLoad: { type: false, blockId: false },
    }
  },
}); // end LOGFAB

}); // end define

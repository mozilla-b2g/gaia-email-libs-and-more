/**
 * Presents a message-centric view of a slice of time from IMAP search results.
 * Responsible for tracking the state the UI's view-slice at the other end of
 * the bridge is aware of.
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
    './imapchew',
    'mailparser/mailparser',
    'exports'
  ],
  function(
    $imapchew,
    $mailparser,
    exports
  ) {

/**
 * Create multiple named callbacks whose results are aggregated and a single
 * callback invoked once all the callbacks have returned their result.  This
 * is intended to provide similar benefit to $Q.all in our non-promise world
 * while also possibly being more useful.
 *
 * Example:
 * @js{
 *   var callbacks = allbackMaker(['foo', 'bar'], function(aggrData) {
 *       console.log("Foo's result was", aggrData.foo);
 *       console.log("Bar's result was", aggrData.bar);
 *     });
 *   asyncFooFunc(callbacks.foo);
 *   asyncBarFunc(callbacks.bar);
 * }
 *
 * Protection against a callback being invoked multiple times is provided as
 * an anti-foot-shooting measure.  Timeout logic and other protection against
 * potential memory leaks is not currently provided, but could be.
 */
function allbackMaker(names, allDoneCallback) {
  var aggrData = {}, callbacks = {}, waitingFor = names.concat();

  names.forEach(function(name) {
    // (build a consistent shape for aggrData regardless of callback ordering)
    aggrData[name] = undefined;
    callbacks[name] = function(callbackResult) {
      var i = waitingFor.indexOf(name);
      if (i === -1) {
        console.error("Callback '" + name + "' fired multiple times!");
        throw new Error("Callback '" + name + "' fired multiple times!");
      }
      waitingFor.splice(i, 1);
      aggrData[name] = callbackResult;
      if (waitingFor.length === 0)
        allDoneCallback(aggrData);
    };
  });

  return callbacks;
}

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
 * Stitches together multiple IMAP slices to present a unified folder.  This
 * is fairly straightforward; when growing in either direction, we first make
 * sure all the underlying slices have the minimum coverage we need, and then
 * we interleave them.
 */
function UnifyingImapSlice() {
}
UnifyingImapSlice.prototype = {
};

function headerYoungToOldComparator(a, b) {
  var delta = b.date - a.date;
  if (delta)
    return delta;
  // favor larger UIDs because they are newer-ish.
  return b.id - a.id;
}

/**
 * Book-keeping and agency for the slices.  Agency in the sense that if we sync
 * the last 2 weeks' time-span but don't get enough messages out of it, this
 * is the logic that requests the next time window.
 */
function ImapSlice(bridgeHandle, startTS, endTS) {
  this.startTS = startTS;
  this.endTS = endTS;

  this.headers = [];
}
ImapSlice.prototype = {
  noteRanges: function() {
    // XXX implement and contend with the generals problem.  probably just have
    // the other side name the values by id rather than offsets.
  },

  grow: function(dirMagnitude) {
  },

  setStatus: function(status) {
    this.bridgeHandle.sendStatus('status');
  },

  onHeaderAdded: function(header) {
    // XXX insertion point logic; deuxdrop must have this
  },

  onHeaderModified: function(header) {
    // XXX this can only affect flags, just send the state mutation
  },

  onHeaderRemoved: function(header) {
    // XXX find the location, splice it.
  },
};

const BASELINE_SEARCH_OPTIONS = ['!DRAFT'];

/**
 * What is the maximum number of bytes a block should store before we split
 * it.
 */
const MAX_BLOCK_SIZE = 96 * 1024;

////////////////////////////////////////////////////////////////////////////////
// Time
//
// The stock IMAP SEARCH command's SINCE and BEFORE predicates only operate on
// whole-dates (and ignore the non-date time parts).  Additionally, SINCE is
// inclusive and BEFORE is exclusive.
//
// We use JS millisecond timestamp values throughout, and it's important to us
// that our date logic is consistent with IMAP's time logic.  Accordingly,
// all of our time-interval related logic operates on day granularities.  Our
// timestamp/date values are always normalized to midnight which happily works
// out with intuitive range operations.
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
// our comparison logic ridiculously explicit.
//
// Our date ranges are defined by 'startTS' and 'endTS'.  Using math syntax,
// that gets us: [startTS, endTS).  It is always true that:
// BEFORE(startTS, endTS) and SINCE(endTS, startTS).
//
// Word pairs considered: [history, present), [longago, recent),
// [oldest, youngest), [latest, earliest), [start, end).  I tried
// oldest/youngest for a while because it seemed conceptually less ambiguous,
// but the fact that age grows in the opposite direction of time made it worse.
// And so we're back to start/end because even if you overthink it, causality
// demands only one logical ordering.
//
// The range-check logic for checking if a date-range falls in a range
// defined by startTS and endTS is then:
//   (SINCE(testDate, startTS) && BEFORE(testDate, endTS))


/**
 * Read this as "Is `testDate` BEFORE `comparisonDate`"?
 *
 * !BEFORE(a, b) === SINCE(a, b)
 */
function BEFORE(testDate, comparisonDate) {
  // testDate is numerically less than comparisonDate, so it is chronologically
  // before it.
  return testDate < comparisonDate;
}

/**
 * Read this as "Is `testDate` SINCE `comparisonDate`"?
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
var TIME_WARPED_NOW = null;
/**
 * Pretend that 'now' is actually a fixed point in time for the benefit of
 * unit tests using canned message stores.
 */
exports.TEST_LetsDoTheTimewarpAgain = function(fakeNow) {
  TIME_WARPED_NOW = fakeNow;
};

/**
 * Make a timestamp some number of days in the past.
 */
function makeDaysAgo(numDays) {
  var now = TIME_WARPED_NOW || Date.now(),
      past = now - numDays * DAY_MILLIS;
  return past;
}
/**
 * Return the
 */
function makeSlightlyYoungerDay(ts) {
}
function makeSlightlyOlderDay(ts) {
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
const INITIAL_FILL_SIZE = 12;
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
    headers: ['FROM', 'TO', 'CC', 'BCC', 'SUBJECT', 'REPLY-TO'],
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

  this._conn = null;
}
ImapFolderConn.prototype = {
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
      var self = this;
      this._account.__folderDemandsConnection(
        this._storage.folderId,
        function(conn) {
          self._conn = conn;
          // Now we have a connection, but it's not in the folder.
          // (If we were doing fancier sync like QRESYNC, we would not enter
          // in such a blase fashion.)
          self._conn.openBox(self._storage.folderMeta.path, function(err) {
              if (err) {
                console.error('Problem entering folder',
                              self._storage.folderMeta.path);
                return;
              }
              self._reliaSearch(searchOptions, callback);
            });
        });
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
  syncDateRange: function(endTS, startTS, newToOld, slice) {
    var searchOptions = BASELINE_SEARCH_OPTIONS.concat(), self = this,
      storage = self._storage;
    if (endTS)
      searchOptions.push(['SINCE', endTS]);
    if (startTS)
      searchOptions.push(['BEFORE', startTS]);

    var callbacks = allbackMaker(
      ['search', 'db'],
      function syncDateRangeLogic(results) {
        var serverUIDs = results.search, headers = results.db,
            knownUIDs = [], uid, numDeleted = 0;

        // -- infer deletion, flag to distinguish known messages
        // rather than splicing lists and causing shifts, we null out values.
        for (var iMsg = 0; iMsg < headers.length; iMsg++) {
          var header = headers[iMsg];
          var idxUid = serverUIDs.indexOf(header.id);
          // deleted!
          if (idxUid === -1) {
            storage.deleteMessageHeader(header);
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

        self._commonSync(newUIDs, knownUIDs, headers);
      });

    this._reliaSearch(searchOptions, callbacks.search);
    this._storage.getAllMessagesInDateRange(startTS, endTS,
                                            callbacks.db);
  },

  searchDateRange: function(endTS, startTS, newToOld, searchParams,
                            slice) {
    var searchOptions = BASELINE_SEARCH_OPTIONS.concat(searchParams);
    if (endTS)
      searchOptions.push(['SINCE', endTS]);
    if (startTS)
      searchOptions.push(['BEFORE', startTS]);
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
          mparser._createMimeNode(null);
          // nb: mparser._multipartTree is an empty list (always)
          mparser._currentNode.meta.contentType =
            partDef.type + '/' + partDef.subtype;
          mparser._currentNode.meta.charset =
            partDef.params && partDef.params.charset;
          mparser._currentNode.meta.transferEncoding =
            partDef.ecoding;
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
        newChewReps.forEach(function(chewRep, iChewRep) {
          var partsReceived = [];
          chewRep.bodyParts.forEach(function(bodyPart) {
            var fetcher = conn.fetch(chewRep.msg.id, opts);
            setupBodyParser(bodyPart);
            fetcher.on('message', function(msg) {
              setupBodyParser(bodyPart);
              msg.on('data', bodyParseBuffer);
              msg.on('end', function() {
                partsReceived.push(finishBodyParsing());
                // -- Process
                if (partsReceived.length === chewRep.bodyParts.length) {
                  if ($imapchew.chewBodyParts(chewRep, partsReceived)) {
                    storage.addMessageHeader(chewRep.header);
                    storage.addMessageBody(chewRep.header, chewRep.bodyInfo);
                  }
                }
              });
            });

            // If this is the last chew rep, then use its completion to report
            // our completion.
            if (iChewRep === newChewReps.length) {
              fetcher.on('end', function() {
                doneCallback();
              });
            }
          });
        });
      });

    // -- Fetch updated flags for known UIDs
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

          if (header.flags.toString() !== msg.flags.toString()) {
            header.flags = msg.flags;
            storage.updateMessageHeader(header);
          }
        });
      });
    knownFetcher.on('error', function onKnownFetchError(err) {
        // XXX the UID might have disappeared already?  we might need to have
        // our initiating command re-do whatever it's up to.  Alternatively,
        // we could drop back from a bulk fetch to a one-by-one fetch.
        console.warn('Known UIDs fetch error, ideally harmless:', err);
      });

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
 * }
 * @typedef[FolderBlockInfo @dict[
 *   @key[blockId BlockId]{
 *     The name of the block for storage access.
 *   }
 *   @key[endTS DateMS]{
 *     The timestamp in milliseconds of the endTS message in the block where
 *     age/the timestamp is determined by the IMAP internaldate.
 *   }
 *   @key[startTS DateMS]{
 *     The timestamp in milliseconds of the startTS message in the block where
 *     age/the timestamp is determined by the IMAP internaldate.
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
 *   @key[author NameAddressPair]
 *   @key[date DateMS]
 *   @key[flags @listof[String]]
 *   @key[hasAttachments Boolean]
 *   @key[subject String]
 *   @key[snippet String]
 * ]]
 * @typedef[HeaderBlock @dict[
 *   @key[uids @listof[UID]]
 *   @key[headers @listof[HeaderInfo]]
 * ]]
 * @typedef[AttachmentInfo @dict[
 *   @key[filename String]
 *   @key[mimetype String]
 *   @key[size Number]{
 *     Estimated file size in bytes.
 *   }
 * ]]
 * @typedef[BodyInfo @dict[
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
 * @typedef[BodyBlock @dictof[
 *   @key["unique identifier" UID]
 *   @value[BodyInfo]
 * ]]
 */
function ImapFolderStorage(account, folderId, persistedFolderInfo) {
  /** Our owning account. */
  this._account = account;
  this._imapDb = null;

  this.folderId = folderId;
  this.folderMeta = persistedFolderInfo.$meta;
  /**
   * @listof[AccuracyRangeInfo]{
   *   Younged-to-startTS sorted list of accuracy range info structures.
   * }
   */
  this._accuracyRanges = persistedFolderInfo.accuracy;
  /**
   * @listof[FolderBlockInfo]{
   *   EndTS-to-startTS sorted list of header folder block infos.
   * }
   */
  this._headerBlockInfos = persistedFolderInfo.headerBlocks;
  /**
   * @listof[FolderBlockInfo]{
   *   EndTS-to-startTS sorted list of body folder block infos.
   * }
   */
  this._bodyBlockInfos = persistedFolderInfo.bodyBlocks;

  this._headerBlocks = {};
  this._bodyBlocks = {};

  this._dirtyHeaderBlocks = {};
  this._dirtyBodyBlocks = {};

  /**
   * @listof[BlockId]
   */
  this._pendingLoads = [];
  /**
   * @dictof[
   *   @key[BlockId]
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

  this._slices = [];
}
exports.ImapFolderStorage = ImapFolderStorage;
ImapFolderStorage.prototype = {
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
  _findRangeObjIndexForDate: function(list, date) {
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
   * Find the first object that contains date ranges that overlaps the provided
   * date range.
   */
  _findFirstObjIndexForDateRange: function(list, startTS, endTS) {
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
   * Find the first object in the list whose `date` falls inside the given
   * date range.
   */
  _findFirstObjForDateRange: function(list, startTS, endTS) {
    var i;
    for (i = 0; i < list.length; i++) {
      var date = list[i].date;
      if (IN_BS_DATE_RANGE(date, startTS, endTS))
        return [i, list[i]];
    }
    return [i, null];
  },

  /**
   * Find (and possibly update) an existing block info metadata structure or
   * create a new block info (and block) if required.  While this method is
   * not specialized to header/body blocks in general, when creating a new
   * block it does know how to initialize an empty block appropriately.  The
   * caller is responsible for inserting the item into the block, which may
   * first require loading the block from disk.
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
   * - When splitting, if we are the first or last block, split 2/3 towards the
   *   center and 1/3 towards the edge.  The idea is that growth is most likely
   *   to occur near the edges, so concentrate the empty space there without
   *   leaving the center blocks so overloaded they can't accept random
   *   additions without further splits.
   *
   * == Block I/O
   *
   * While we can make decisions about where to insert things, we need to have
   * blocks in memory in order to perform the actual splits.  The outcome
   * of splits can't be predicted because the size of things in blocks is
   * only known when the block is loaded.
   */
  _pickInsertionBlockUsingDate: function(type, date, cost) {
    var blockInfoList = (type === 'header' ? this._headerBlockInfos
                                           : this._bodyBlockInfos);

    // - find the current containing block / insertion point
    var infoTuple = this._findRangeObjIndexForDate(blockInfoList, date),
        iInfo = infoTuple[0], info = infoTuple[1];

    // -
    if (info) {

    }
  },

  /**
   * Request the load of the given block and the invocation of the callback with
   * the block when the load completes.
   */
  _loadBlock: function(type, blockId, callback) {
    var aggrId = type + blockId;
    if (this._pendingLoads.indexOf(aggrId) !== -1) {
      this._pendingLoadListeners[aggrId].push(callback);
      return;
    }

    var index = this._pendingLoads.length;
    this._pendingLoads.push(aggrId);
    this._pendingLoadListeners[aggrId] = [callback];

    function onLoaded(block) {
      this._pendingLoads.splice(index, 1);
      var listeners = this._pendingLoadListeners[aggrId];
      delete this._pendingLoadListeners[aggrId];
      for (var i = 0; i < listeners.length; i++) {
        listeners[i](block);
      }
    }

    if (type === 'header')
      this._imapDb.loadHeaderBlock(this.folderId, blockId, onLoaded);
    else
      this._imapDb.loadBodyBlock(this.folderId, blockId, onLoaded);
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
  sliceOpenFromNow: function(slice, daysDesired) {
    this._slices.push(slice);

    // -- Check if we have sufficiently useful data on hand.
    var now = TIME_WARPED_NOW || Date.now(),
        pastDate = makeDaysAgo(daysDesired),
        iAcc, iHeadBlock, ainfo,
        // What is the startTS fullSync data we have for the time range?
        worstGoodData = null;
    for (iAcc = 0; iAcc < this._accuracyRanges.length; i++) {
      ainfo = this._accuracyRanges[iAcc];
      if (pastDate < ainfo.endTS)
        break;
      if (!ainfo.fullSync)
        break;
      if (worstGoodData)
        worstGoodData = Math.min(ainfo.fullSync.updated, worstGoodData);
      else
        worstGoodData = ainfo.fullSync.updated;
    }
    var existingDataGood = (worstGoodData + RECENT_ENOUGH_TIME_THRESH > now);

    // -- Good existing data, fill the slice from the DB
    if (existingDataGood) {
      this.getMessagesInDateRange(now, pastDate, INITIAL_FILL_SIZE, false);
      return;
    }
    // -- Bad existing data, issue a sync and have the slice
    slice.setStatus('synchronizing');
  },

  sliceQuicksearch: function(slice, searchParams) {
  },

  /**
   * Retrieve the (ordered list) of messages covering a given date range that
   * we know about.
   *
   * @args[
   *   @param[endTS]
   *   @param[startTS]
   *   @param[limit #:optional]
   *   @param[messageCallback @func[
   *     @args[
   *       @param[headers @listof[HeaderInfo]]
   *       @param[moreMessagesComing Boolean]]
   *     ]
   *   ]
   * ]
   */
  getMessagesInDateRange: function(endTS, startTS, limit,
                                   messageCallback) {
    var toFill = (limit != null) ? limit : TOO_MANY_MESSAGES, self = this,
        // header block info iteration
        iHeadBlockInfo = null, headBlockInfo;


    // find the first header block with the data we want
    [iHeadBlockInfo, headBlockInfo] =
      self._findRangeObjIndexForDateRange(this._headerBlockInfos,
                                          startTS, endTS);
    if (!headBlockInfo) {
      // no blocks equals no messages.
      messageCallback([], false);
      return;
    }

    function fetchMore() {
      while (true) {
        // - load the header block if required
        if (!(headBlockInfo.id in self._headerBlocks)) {
          self._loadBlock('header', headBlockInfo.id, fetchMore);
          return;
        }
        var headerBlock = self._headerBlocks[headblockInfo.id];
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
        for (; toFill && iHeader < headerBlock.headers.length; iHeader++) {
          header = headerBlock.headers[iHeader];
          if (header.date < startTS)
            break;
        }
        // (iHeader is pointing at the index of message we don't want)
        toFill -= iHeader - iFirstHeader;
        messageCallback(headerBlock.headers.slice(iFirstHeader, iHeader),
                        Boolean(toFill));
        // bail if there is nothing left to fill or we ran into an undesirable
        if (toFill || iHeader < headerBlock.headers.length)
          return;
        // - There may be viable messages in the next block, check.
        if (++iHeadBlockInfo >= self._headerBlockInfos.length)
          return;
        headBlockInfo = self._headerBlockInfos[iHeadBlockInfo];
        if (startTS > headBlockInfo.endTS)
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
  getAllMessagesInDateRange: function(startTS, endTS, allCallback) {
    var allHeaders = null;
    function someMessages(headers, moreHeadersExpected) {
      if (allHeaders)
        allHeaders = allHeaders.concat(headers);
      else
        allHeaders = headers;
      if (!moreHeadersExpected)
        allCallback(allHeaders);
    }
  },

  /**
   * Mark a given time range as synchronized.
   *
   * XXX punting on for now; this will cause synchronization to always occur
   * prior to attempting to populate the slice.
   */
  markSyncRange: function(startTS, endTS, modseq, dateMS) {
    // - Find all overlapping accuracy ranges.
    // - Split younger overlap if partial
    // - Split older overlap if partial
  },

  /**
   * Add a new message to the database, generating slice notifications.
   */
  addMessageHeader: function(header) {
    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.addMessageHeader.bind(this, header));
      return;
    }
  },

  /**
   * Update an existing mesage header in the database, generating slice
   * notifications and dirtying its containing block to cause eventual database
   * writeback.
   */
  updateMessageHeader: function(header) {
    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.updateMessageHeader.bind(this, header));
      return;
    }
  },

  deleteMessageHeader: function(header) {
    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.deleteMessageHeader.bind(this, header));
      return;
    }
  },

  /**
   *
   */
  addMessageBody: function(header, bodyInfo) {
    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.addMessageBody.bind(this, header,
                                                        bodyInfo));
      return;
    }
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

}); // end define

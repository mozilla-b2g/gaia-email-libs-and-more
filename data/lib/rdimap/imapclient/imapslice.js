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
 * === Batching ===
 *
 * We do a few different types of batching based on the current sync state,
 * with these choices being motivated by UX desires and some efficiency desires
 * (in pursuit of improved UX).  We want the user to feel like they get their
 * messages quickly, but we also don't want messages jumping all over the
 * screen.
 *
 * - Fresh sync (all messages are new to us): Messages are being added from
 *   most recent to oldest.  Currently, we just let this pass through, but
 *   we might want to do some form of limited time-based batching.  (ex:
 *   wait 50ms or for notification of completion before sending a batch).
 *
 * - Refresh (sync): No action required because we either already have the
 *   messages or get them in efficient-ish batches.  This is followed by
 *   what should be minimal changes (and where refresh was explicitly chosen
 *   to be used rather than date sync for this reason.)
 *
 * - Date sync (some messages are new, some messages are known):  We currently
 *   get the known headers added one by one from youngest to oldest, followed
 *   by the new messages also youngest to oldest.  The notional UX (enforced
 *   by unit tests) for this is that we want all the changes coherently and with
 *   limits made effective.  To this end, we do not generate any splices until
 *   sync is complete and then generate a single slice.
 */
function ImapSlice(bridgeHandle, storage, _parentLog) {
  this._bridgeHandle = bridgeHandle;
  bridgeHandle.__listener = this;
  this._storage = storage;
  this._LOG = LOGFAB.ImapSlice(this, _parentLog, bridgeHandle._handle);

  // The time range of the headers we are looking at right now.
  this.startTS = null;
  this.startUID = null;
  // If the end values line up with the most recent message known about for this
  // folder, then we will grow to encompass more recent messages.
  this.endTS = null;
  this.endUID = null;

  /**
   * A string value for hypothetical debugging purposes, but which is coerced
   * to a Boolean value for some of our slice notifications as both the
   * userRequested/moreExpected values, although they aren't super important.
   */
  this.waitingOnData = false;

  /**
   * When true, we are not generating splices and are just accumulating state
   * in this.headers.
   */
  this._accumulating = false;

  /**
   * @listof[HeaderInfo]
   */
  this.headers = [];
  this.desiredHeaders = INITIAL_FILL_SIZE;
}
exports.ImapSlice = ImapSlice;
ImapSlice.prototype = {
  set atTop(val) {
    this._bridgeHandle.atTop = val;
  },
  set atBottom(val) {
    this._bridgeHandle.atBottom = val;
  },
  set userCanGrowDownwards(val) {
    this._bridgeHandle.userCanGrowDownwards = val;
  },

  _updateSliceFlags: function() {
    var flagHolder = this._bridgeHandle;
    flagHolder.atTop = this._storage.headerIsYoungestKnown(this.endTS,
                                                           this.endUID);
    flagHolder.atBottom = this._storage.headerIsOldestKnown(this.startTS,
                                                            this.startUID);
    if (flagHolder.atBottom) {
      flagHolder.userCanGrowDownwards =
        !this._storage.syncedToDawnOfTime();
    }
    else {
      flagHolder.userCanGrowDownwards = false;
    }
  },

  /**
   * Clear out any known headers because a refresh went wrong and so we are
   * converting our refresh into a sync.
   */
  _resetHeadersBecauseOfRefreshExplosion: function() {
    if (this.headers.length) {
      // If we're accumulating, we were starting from zero to begin with, so
      // there is no need to send a nuking splice.
      if (!this._accumulating)
        this._bridgeHandle.sendSplice(0, this.headers.length, [], false, true);
      this.headers.splice(0, this.headers.length);
      this.startTS = null;
      this.startUID = null;
      this.endTS = null;
      this.endUID = null;
    }
  },

  /**
   * Force an update of our current date range.
   */
  refresh: function() {
    this._storage.refreshSlice(this);
  },

  reqNoteRanges: function(firstIndex, firstSuid, lastIndex, lastSuid) {
    var i;
    // - Fixup indices if required
    if (firstIndex >= this.headers.length ||
        this.headers[firstIndex].suid !== firstSuid) {
      firstIndex = 0; // default to not splicing if it's gone
      for (i = 0; i < this.headers.length; i++) {
        if (this.headers[i].suid === firstSuid) {
          firstIndex = i;
          break;
        }
      }
    }
    if (lastIndex >= this.headers.length ||
        this.headers[lastIndex].suid !== lastSuid) {
      for (i = this.headers.length - 1; i >= 0; i--) {
        if (this.headers[i].suid === lastSuid) {
          lastIndex = i;
          break;
        }
      }
    }

    // - Perform splices as required
    // (high before low to avoid index changes)
    if (lastIndex + 1 < this.headers.length) {
      this.atBottom = false;
      this.userCanGrowDownwards = false;
      var delCount = this.headers.length - lastIndex  - 1;
      this.desiredHeaders -= delCount;
      if (!this._accumulating)
        this._bridgeHandle.sendSplice(
          lastIndex + 1, delCount, [],
          // This is expected; more coming if there's a low-end splice
          true, firstIndex > 0);
      this.headers.splice(lastIndex + 1, this.headers.length - lastIndex - 1);
      var lastHeader = this.headers[lastIndex];
      this.startTS = lastHeader.date;
      this.startUID = lastHeader.id;
    }
    if (firstIndex > 0) {
      this.atTop = false;
      this.desiredHeaders -= firstIndex;
      if (!this._accumulating)
        this._bridgeHandle.sendSplice(0, firstIndex, [], true, false);
      this.headers.splice(0, firstIndex);
      var firstHeader = this.headers[0];
      this.endTS = firstHeader.date;
      this.endUID = firstHeader.id;
    }
  },

  reqGrow: function(dirMagnitude, userRequestsGrowth) {
    if (dirMagnitude === -1)
      dirMagnitude = -INITIAL_FILL_SIZE;
    else if (dirMagnitude === 1)
      dirMagnitude = INITIAL_FILL_SIZE;
    this._storage.growSlice(this, dirMagnitude, userRequestsGrowth);
  },

  sendEmptyCompletion: function() {
    this.setStatus('synced', true, false);
  },

  setStatus: function(status, requested, moreExpected, flushAccumulated) {
    if (!this._bridgeHandle)
      return;

    if (status === 'synced') {
      this._updateSliceFlags();
    }
    if (flushAccumulated && this._accumulating) {
      if (this.headers.length > this.desiredHeaders) {
        this.headers.splice(this.desiredHeaders,
                            this.headers.length - this.desiredHeaders);
        this.endTS = this.headers[this.headers.length - 1].date;
        this.endUID = this.headers[this.headers.length - 1].id;
      }

      this._accumulating = false;
      this._bridgeHandle.status = status;
      // XXX remove concat() once our bridge sending makes rep sharing
      // impossible by dint of actual postMessage or JSON roundtripping.
      this._bridgeHandle.sendSplice(0, 0, this.headers.concat(),
                                    requested, moreExpected);
    }
    else {
      this._bridgeHandle.sendStatus(status, requested, moreExpected);
    }
  },

  batchAppendHeaders: function(headers, insertAt, moreComing) {
    this._LOG.headersAppended(headers);
    if (insertAt === -1)
      insertAt = this.headers.length;
    this.headers.splice.apply(this.headers, [insertAt, 0].concat(headers));

    // XXX this can obviously be optimized to not be a loop
    for (var i = 0; i < headers.length; i++) {
      var header = headers[i];
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
    }

    this._updateSliceFlags();
    if (!this._accumulating)
      this._bridgeHandle.sendSplice(insertAt, 0, headers,
                                    true, moreComing);
  },

  /**
   * Tell the slice about a header it should be interested in.  This should
   * be unconditionally called by a sync populating this slice, or conditionally
   * called when the header is in the time-range of interest and a refresh,
   * cron-triggered sync, or IDLE/push tells us to do so.
   */
  onHeaderAdded: function(header, syncDriven) {
    if (!this._bridgeHandle)
      return;

    var idx = bsearchForInsert(this.headers, header,
                               cmpHeaderYoungToOld);
    var hlen = this.headers.length;
    // Don't append the header if it would expand us beyond our requested amount
    // and there is no subsequent step, like accumulate flushing, that would get
    // rid of the excess.  Note that this does not guarantee that we won't
    // end up with more headers than originally planned; if we get told about
    // headers earlier than the last slot, we will insert them and grow without
    // forcing a removal of something else to offset.
    if (hlen >= this.desiredHeaders && idx === hlen &&
        !this._accumulating)
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

    this._LOG.headerAdded(idx, header);
    if (!this._accumulating)
      this._bridgeHandle.sendSplice(idx, 0, [header],
                                    Boolean(this.waitingOnData),
                                    Boolean(this.waitingOnData));
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
      // There is no identity invariant to ensure this is already true.
      this.headers[idx] = header;
      this._LOG.headerModified(idx, header);
      // If we are accumulating, the update will be observed.
      if (!this._accumulating)
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
      if (!this._accumulating)
        this._bridgeHandle.sendSplice(idx, 1, [],
                                      Boolean(this.waitingOnData),
                                      Boolean(this.waitingOnData));
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

/**
 * We don't care about deleted messages, it's best that we're not aware of them.
 * However, it's important to keep in mind that this means that EXISTS provides
 * us with an upper bound on the messages in the folder since we are blinding
 * ourselves to deleted messages.
 */
const BASELINE_SEARCH_OPTIONS = ['!DELETED'];

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
//             ________________________________________
//      BEFORE)| midnight (0 millis) ... 11:59:59:999 |
// ON_OR_BEFORE]
//             [SINCE......................................
//              (AFTER.....................................
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
const HEADER_EST_SIZE_IN_BYTES = exports.HEADER_EST_SIZE_IN_BYTES = 200;

const HOUR_MILLIS = 60 * 60 * 1000;
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
      past = (FUTURE_TIME_WARPED_NOW || quantizeDate(Date.now())) -
               (numDays + 1) * DAY_MILLIS;
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

////////////////////////////////////////////////////////////////////////////////
// Display Heuristic Time Values
//
// Here are some values we can tweak to try and strike a balance between how
// long before we display something when entering a folder and avoiding visual
// churn as new messages are added to the display.
//
// These are not constants because unit tests need to muck with these.

/**
 * How recently do we have to have synced a folder for us to to treat a request
 * to enter the folder as a database-backed load followed by a refresh rather
 * than falling back to known-date-range sync (which does not display anything
 * until the sync has completed) or (the same thing we use for initial sync)
 * iterative deepening?
 *
 * This is sync strategy #1 per `sliceOpenFromNow`.
 *
 * A good value is approximately how long we would expect it to take for V/2
 * messages to show up in the folder, where V is the number of messages the
 * device's screen can display at a time.  This is because since we will
 * populate the folder prior to the refresh, any new messages will end up
 * displacing the messages.
 *
 * There are non-inbox and inbox variants of this value because we expect
 * churn in the INBOX to happen at a much different rate than other boxes.
 * Ideally, we might also be able to detect folders that have new things
 * filtered into them, as that will affect this too.
 *
 * There is also a third variant for folders that we have previously
 * synchronized and found that their messages start waaaay in the past,
 * suggesting that this is some type of archival folder with low churn,
 * `SYNC_REFRESH_USABLE_DATA_OLD_IS_SAFE_THRESH`.
 */
var SYNC_REFRESH_USABLE_DATA_TIME_THRESH_NON_INBOX = 6 * HOUR_MILLIS;
var SYNC_REFRESH_USABLE_DATA_TIME_THRESH_INBOX = 2 * HOUR_MILLIS;

/**
 * If the most recent message in a folder is older than this threshold, then
 * we assume it's some type of archival folder and so is unlikely to have any
 * meaningful churn so a refresh is optimal.  Also, the time range is
 * far enough back that our deepening strategy would result in unacceptable
 * latency.
 */
var SYNC_REFRESH_USABLE_DATA_OLD_IS_SAFE_THRESH = 4 * 30 * DAY_MILLIS;
var SYNC_REFRESH_USABLE_DATA_TIME_THRESH_OLD = 2 * 30 * DAY_MILLIS;

/**
 * How recently do we have to have synced a folder for us to reuse the known
 * date bounds of the messages contained in the folder as the basis for our
 * sync?  We will perform a sync with this date range before displaying any
 * messages, avoiding churn should new messages have appeared.
 *
 * This is sync strategy #2 per `sliceOpenFromNow`, and is the fallback mode
 * if the #1 strategy is not appropriate.
 *
 * This is most useful for folders with a message density lower than
 * INITIAL_FILL_SIZE / INITIAL_SYNC_DAYS messages/day.  If we are able
 * to characterize folders based on whether new messages show up in them
 * based on some reliable information, then we could let #1 handle more cases
 * that this case currently covers.
 */
var SYNC_USE_KNOWN_DATE_RANGE_TIME_THRESH_NON_INBOX = 7 * DAY_MILLIS;
var SYNC_USE_KNOWN_DATE_RANGE_TIME_THRESH_INBOX = 6 * HOUR_MILLIS;

////////////////////////////////////////////////////////////////////////////////

/**
 * How many messages should we send to the UI in the first go?
 */
var INITIAL_FILL_SIZE = 15;

/**
 * How many days in the past should we first look for messages.
 */
var INITIAL_SYNC_DAYS = 3;

/**
 * What should be multiple the current number of sync days by when we perform
 * a sync and don't find any messages?  There are upper bounds in
 * `ImapFolderStorage.onSyncCompleted` that cap this and there's more comments
 * there.
 */
var TIME_SCALE_FACTOR_ON_NO_MESSAGES = 1.6;

/**
 * What is the furthest back in time we are willing to go?  This is an
 * arbitrary choice to avoid our logic going crazy, not to punish people with
 * comprehensive mail collections.
 */
const OLDEST_SYNC_DATE = (new Date(1990, 0, 1)).valueOf();

/**
 * If we issued a search for a date range and we are getting told about more
 * than the following number of messages, we will try and reduce the date
 * range proportionately (assuming a linear distribution) so that we sync
 * a smaller number of messages.  This will result in some wasted traffic
 * but better a small wasted amount (for UIDs) than a larger wasted amount
 * (to get the dates for all the messages.)
 */
var SYNC_BISECT_DATE_AT_N_MESSAGES = 50;

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
var TOO_MANY_MESSAGES = 2000;

/**
 * Testing support to adjust the value we use for the number of initial sync
 * days.  The tests are written with a value in mind (7), but 7 turns out to
 * be too high an initial value for actual use, but is fine for tests.
 */
exports.TEST_adjustSyncValues = function TEST_adjustSyncValues(syncValues) {
  INITIAL_FILL_SIZE = syncValues.fillSize;
  INITIAL_SYNC_DAYS = syncValues.days;

  SYNC_BISECT_DATE_AT_N_MESSAGES = syncValues.bisectThresh;
  TOO_MANY_MESSAGES = syncValues.tooMany;

  TIME_SCALE_FACTOR_ON_NO_MESSAGES = syncValues.scaleFactor;

  SYNC_REFRESH_USABLE_DATA_TIME_THRESH_NON_INBOX =
    syncValues.refreshNonInbox;
  SYNC_REFRESH_USABLE_DATA_TIME_THRESH_INBOX =
    syncValues.refreshInbox;
  SYNC_REFRESH_USABLE_DATA_OLD_IS_SAFE_THRESH =
    syncValues.oldIsSafeForRefresh;
  SYNC_REFRESH_USABLE_DATA_TIME_THRESH_OLD =
    syncValues.refreshOld;

  SYNC_USE_KNOWN_DATE_RANGE_TIME_THRESH_NON_INBOX =
    syncValues.useRangeNonInbox;
  SYNC_USE_KNOWN_DATE_RANGE_TIME_THRESH_INBOX =
    syncValues.useRangeInbox;
};


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
    headers: ['FROM', 'TO', 'CC', 'BCC', 'SUBJECT', 'REPLY-TO', 'MESSAGE-ID',
              'REFERENCES'],
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
  syncDateRange: function(startTS, endTS, accuracyStamp, useBisectLimit,
                          doneCallback) {
console.log("syncDateRange:", startTS, endTS);
    var searchOptions = BASELINE_SEARCH_OPTIONS.concat(), self = this,
      storage = self._storage;
    if (!useBisectLimit)
      useBisectLimit = SYNC_BISECT_DATE_AT_N_MESSAGES;
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
          var effEndTS = endTS || FUTURE_TIME_WARPED_NOW ||
                           quantizeDate(Date.now() + DAY_MILLIS),
              curDaysDelta = (effEndTS - startTS) / DAY_MILLIS;
          // We are searching more than one day, we can shrink our search.

console.log('BISECT CASE', serverUIDs.length, 'curDaysDelta', curDaysDelta);
          if (curDaysDelta > 1) {
            // Sanity check the time delta; if we grew the bounds to the dawn
            // of time, then our interpolation is useless and it's better for
            // us to crank things way down, even if it's erroneously so.
            if (curDaysDelta > 1000)
              curDaysDelta = 30;

            // - Interpolate better time bounds.
            // Assume a linear distribution of messages, but overestimated by
            // a factor of two so we undershoot.
            var shrinkScale = SYNC_BISECT_DATE_AT_N_MESSAGES /
                                (serverUIDs.length * 2),
                backDays = Math.max(1,
                                    Math.ceil(shrinkScale * curDaysDelta));
            // mark the bisection abort...
            self._LOG.syncDateRange_end(null, null, null, startTS, endTS);
            var bisectInfo = {
              oldStartTS: startTS,
              dayStep: backDays,
              newStartTS: makeDaysBefore(effEndTS, backDays),
            };
            startTS = bisectInfo.newStartTS;
            // If we were being used for a refresh, they may want us to stop
            // and change their sync strategy.
            if (doneCallback(bisectInfo, null) === 'abort') {
              doneCallback('aborted', null);
              return null;
            }
console.log("backoff! had", serverUIDs.length, "from", curDaysDelta,
            "startTS", startTS, "endTS", endTS, "backDays", backDays);
            return self.syncDateRange(startTS, endTS, accuracyStamp, null,
                                      doneCallback);
          }
        }

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

        return self._commonSync(
          newUIDs, knownUIDs, headers,
          function(newCount, knownCount) {
            self._LOG.syncDateRange_end(newCount, knownCount, numDeleted,
                                        startTS, endTS);
            self._storage.markSyncRange(startTS, endTS, modseq,
                                        accuracyStamp);
            doneCallback(null, newCount + knownCount);
          });
      });

    this._LOG.syncDateRange_begin(null, null, null, startTS, endTS);
    this._reliaSearch(searchOptions, callbacks.search);
    this._storage.getAllMessagesInImapDateRange(startTS, endTS, callbacks.db);
  },

  searchDateRange: function(endTS, startTS, searchParams,
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
console.log("_commonSync", 'newUIDs', newUIDs.length, 'knownUIDs',
            knownUIDs.length, 'knownHeaders', knownHeaders.length);
    var callbacks = allbackMaker(
      ['newMsgs', 'knownMsgs'],
      function() {
        // It is possible that async I/O will be required to add a header or a
        // body, so we need to defer declaring the synchronization done until
        // after all of the storage's deferred calls have run because the
        // header/body affecting calls will have been deferred.
        storage.runAfterDeferredCalls(
          doneCallback.bind(null, newUIDs.length, knownUIDs.length));
      });

    // -- Fetch headers/bodystructures for new UIDs
    var newChewReps = [];
    if (newUIDs.length) {
      var newFetcher = this._conn.fetch(newUIDs, INITIAL_FETCH_PARAMS);
      newFetcher.on('message', function onNewMessage(msg) {
          msg.on('end', function onNewMsgEnd() {
console.log('  new fetched, header processing');
            newChewReps.push($imapchew.chewHeaderAndBodyStructure(msg));
console.log('   header processed');
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
              partDef.type.toLowerCase() + '/' +
              partDef.subtype.toLowerCase();
            mparser._currentNode.meta.charset =
              partDef.params && partDef.params.charset &&
              partDef.params.charset.toLowerCase();
            mparser._currentNode.meta.transferEncoding =
              partDef.encoding && partDef.encoding.toLowerCase();
            mparser._currentNode.meta.textFormat =
              partDef.params && partDef.params.format &&
              partDef.params.format.toLowerCase();
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
            // We end up having provided an extra newline that we don't
            // want, so let's cut it off if it exists.
            var content = mparser._currentNode.content;
            if (content.charCodeAt(content.length - 1) === 10)
              content = content.substring(0, content.length - 1);
            return content;
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
            // If there are no parts to process, consume it now.
            if (chewRep.bodyParts.length === 0) {
              if ($imapchew.chewBodyParts(chewRep, partsReceived,
                                          storage.folderId)) {
                storage.addMessageHeader(chewRep.header);
                storage.addMessageBody(chewRep.header, chewRep.bodyInfo);
              }
            }

            chewRep.bodyParts.forEach(function(bodyPart) {
              var opts = { request: { body: bodyPart.partID } };
              pendingFetches++;

console.log('  fetching for', chewRep.msg.id, bodyPart.partID);
              var fetcher;
try {
              fetcher = conn.fetch(chewRep.msg.id, opts);
} catch (ex) {
  console.warn('!failure fetching', ex);
  return;
}
              setupBodyParser(bodyPart);
              fetcher.on('error', function(err) {
                console.warn('body fetch error', err);
                if (--pendingFetches === 0)
                  callbacks.newMsgs();
              });
              fetcher.on('message', function(msg) {
                setupBodyParser(bodyPart);
                msg.on('data', bodyParseBuffer);
                msg.on('end', function() {
                  partsReceived.push(finishBodyParsing());
console.log('  !fetched body part for', chewRep.msg.id, bodyPart.partID,
            partsReceived.length, chewRep.bodyParts.length);

                  // -- Process
                  if (partsReceived.length === chewRep.bodyParts.length) {
                    if ($imapchew.chewBodyParts(chewRep, partsReceived,
                                                storage.folderId)) {
                      storage.addMessageHeader(chewRep.header);
                      storage.addMessageBody(chewRep.header, chewRep.bodyInfo);
                    }
else { console.warn("failure to parse body!!!"); }
                  }
                  // If this is the last chew rep, then use its completion
                  // to report our completion.
                  if (--pendingFetches === 0)
                    callbacks.newMsgs();
                });
              });
            });
          });
console.log('  pending fetches', pendingFetches);
          if (pendingFetches === 0)
            callbacks.newMsgs();
        });
    }
    else {
      callbacks.newMsgs();
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
      knownFetcher.on('end', function() {
        callbacks.knownMsgs();
      });
    }
    else {
      callbacks.knownMsgs();
    }
  },

  downloadMessageAttachments: function(uid, partInfos, callback) {
    var conn = this._conn;
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
      var opts = { request: { body: partInfo.part } };
      pendingFetches++;
      var fetcher = conn.fetch(chewRep.msg.id, opts);

      setupBodyParser(partInfo);
      fetcher.on('error', function(err) {
        if (!anyError)
          anyError = err;
        if (--pendingFetches === 0)
          callback(anyError, bodies);
      });
      fetcher.on('message', function(msg) {
        setupBodyParser(partInfo);
        msg.on('data', bodyParseBuffer);
        msg.on('end', function() {
          bodies.push(finishBodyParsing());

          // If this is the last chew rep, then use its completion
          // to report our completion.
          if (--pendingFetches === 0)
            callback(anyError, bodies);
        });
      });
    });
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
 *   @key[name String]{
 *     The filename of the attachment if this is an attachment, the content-id
 *     of the attachment if this is a related part for inline display.
 *   }
 *   @key[type String]{
 *     The (full) mime-type of the attachment.
 *   }
 *   @key[part String]{
 *     The IMAP part number for fetching the attachment.
 *   }
 *   @key[encoding String]{
 *     The encoding of the attachment so we know how to decode it.
 *   }
 *   @key[sizeEstimate Number]{
 *     Estimated file size in bytes.  Gets updated to be the correct size on
 *     attachment download.
 *   }
 *   @key[file @oneof[
 *     @case[null]{
 *       The attachment has not been downloaded, the file size is an estimate.
 *     }
 *     @case[@list["device storage type" "file path"]{
 *       The DeviceStorage type (ex: pictures) and the path to the file within
 *       device storage.
 *     }
 *     @case[HTMLBlob]{
 *       The Blob that contains the attachment.  It can be thought of as a
 *       handle/name to access the attachment.  IndexedDB in Gecko stores the
 *       blobs as (quota-tracked) files on the file-system rather than inline
 *       with the record, to the attachments don't need to count against our
 *       block size since they are not part of the direct I/O burden for the
 *       block.
 *     }
 *   ]]
 *   @key[charset @oneof[undefined String]]{
 *     The character set, for example "ISO-8859-1".  If not specified, as is
 *     likely for binary attachments, this should be null.
 *   }
 *   @key[textFormat @oneof[undefined String]]{
 *     The text format, for example, "flowed" for format=flowed.  If not
 *     specified, as is likely for binary attachments, this should be null.
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
 *   @key[attachments @listof[AttachmentInfo]]{
 *     Proper attachments for explicit downloading.
 *   }
 *   @key[relatedParts @oneof[null @listof[AttachmentInfo]]]{
 *     Attachments for inline display in the contents of the (hopefully)
 *     multipart/related message.
 *   }
 *   @key[references @oneof[null @listof[String]]]{
 *     The contents of the references header as a list of de-quoted ('<' and
 *     '>' removed) message-id's.  If there was no header, this is null.
 *   }
 *   @key[bodyRep @oneof[String Array]]{
 *     If it's an array, then it's the `quotechew.js` processed body
 *     representation.  If it's a string, then this is an HTML message and the
 *     contents are already sanitized and already quote-normalized.
 *   }
 *   @key[htmlFixups Array]{
 *     The list of fixups that can be performed.  Elements that are strings are
 *     external image URLs.  Elements that are integers are indexes into
 *     `relatedParts`.  All things that need to be fixed up are marked with a
 *     attribute so that we can get the nodes and then in one pass perform the
 *     appropriate fixups.  Or maybe we just need a flag?
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
   * The timestamp to use for `markSyncRange` for all syncs in this higher
   * level sync.  Accuracy time-info does not need high precision, so this
   * results in fewer accuracy structures and simplifies our decision logic
   * in `sliceOpenFromNow`.
   */
  this._curSyncAccuracyStamp = null;
  /**
   * The start range of the (backward-moving) sync time range.
   */
  this._curSyncStartTS = null;
  /**
   * The number of days we are looking into the past in the current sync step.
   */
  this._curSyncDayStep = null;
  /**
   * If non-null, then we must reach a sync start date of the provided date
   * before we begin increasing _curSyncDayStep.  This helps us avoid
   * oscillation where we make the window too large, shrink it, but then find
   * find nothing.  Since we know that there are going to be a lot of messages
   * before we hit this date, it makes sense to keep taking smaller sync steps.
   */
  this._curSyncDoNotGrowWindowBefore = null;

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

    this._dirty = true;
    this._dirtyHeaderBlocks[info.blockId] = block;

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
    // this._dirty is already touched by makeHeaderBlock when it dirties the
    // block it creates.
    this._dirtyHeaderBlocks[splinfo.blockId] = splock;

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
    var body = block.bodies[uid];
    if (idx === -1 || !body) {
      this._LOG.bodyBlockMissing(uid, idx, !!body);
      return;
    }
    block.uids.splice(idx, 1);
    delete block.bodies[uid];
    info.estSize -= body.size;
    info.count--;

    this._dirty = true;
    this._dirtyBodyBlocks[info.blockId] = block;

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
    // _makeBodyBlock dirties the block it creates and touches _dirty
    this._dirtyBodyBlocks[splinfo.blockId] = splock;

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
      // If our comparison range starts AFTER the end of this range, then it
      // does not overlap this range and will never overlap any subsequent
      // ranges because they are all chronologically earlier than this range.
      //
      // nb: We are saying that there is no overlap if one range starts where
      // the other one ends.  This is consistent with the inclusive/exclusive
      // definition of since/before and our ranges.
      if (STRICTLY_AFTER(startTS, info.endTS))
        return [i, null];
      // therefore ON_OR_BEFORE(startTS, info.endTS)

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

  runAfterDeferredCalls: function(callback) {
    if (this._deferredCalls.length)
      this._deferredCalls.push(callback);
    else
      callback();
  },

  /**
   * Run deferred calls until we run out of deferred calls or _pendingLoads goes
   * non-zero again.
   */
  _runDeferredCalls: function ifs__runDeferredCalls() {
    while (this._deferredCalls.length && this._pendingLoads.length === 0) {
      var toCall = this._deferredCalls.shift();
      toCall();
    }
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

      if (self._pendingLoads.length === 0)
        self._runDeferredCalls();
    }

    this._LOG.loadBlock_begin(type, blockId);
    if (type === 'header')
      this._imapDb.loadHeaderBlock(this.folderId, blockId, onLoaded);
    else
      this._imapDb.loadBodyBlock(this.folderId, blockId, onLoaded);
  },

  _deleteFromBlock: function ifs__deleteFromBlock(type, date, uid, callback) {
    var blockInfoList, blockMap, deleteFromBlock;
    this._LOG.deleteFromBlock(type, date, uid);
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
      this._LOG.badDeletionRequest(type, date, uid);
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
   * There are three core strategies we can use, listed in order of immediacy
   * of results:
   *
   * 1) Immediately display the most recent messages we have in the folder and
   *    then trigger a refresh over the time range covering 'now' through the
   *    oldest message we displayed which may add/modify/remove messages from
   *    the displayed list.
   *
   * 2) Use our knowledge of the messages in the folder to issue a sync request
   *    over the time range that we think will net us a reasonable number of
   *    messages, only displaying any messages once the sync over that time
   *    range completes.
   *
   * 3) (Act like) we know nothing about the messages in the folder, issuing
   *    an initial sync request over `daysDesired`/`INITIAL_SYNC_DAYS`, and
   *    issuing successive sync requests back further in time as we go,
   *    adjusting the size of the sync requests as we go.
   *
   * If we are offline, we basically do #1 but without triggering a refresh.
   *
   * The strategies we use are controlled via constants that are documented in
   * the "Display Heuristic Time Values" group in this file and which elaborate
   * on these strategies a bit more.  Also, the comments in the method may be
   * informative.
   */
  sliceOpenFromNow: function ifs_sliceOpenFromNow(slice, daysDesired,
                                                  forceDeepening) {
    daysDesired = daysDesired || INITIAL_SYNC_DAYS;
    this._slices.push(slice);
    if (this._curSyncSlice) {
      console.error("Trying to open a slice and initiate a sync when there",
                    "is already an active sync slice!");
    }
    // by definition, we must be at the top
    slice.atTop = true;

    // -- Check if we have sufficiently useful data on hand.
    // For checking accuracy ranges, the first accuracy range is authoritative
    // for at least all of what `sliceOpenFromNow` returned last time, so we can
    // just check against it.  (It may have been bisected by subsequent scrolled
    // refreshes, but they will be more recent and thus won't affect the least
    // accurate data, which is what we care about.)
    var now = TIME_WARPED_NOW || Date.now(),
        futureNow = FUTURE_TIME_WARPED_NOW || null,
        pastDate = makeDaysAgo(daysDesired),
        iAcc, iHeadBlock, ainfo,
        // What is the startTS fullSync data we have for the time range?
        worstGoodData = 0,
        existingDataGood = false;

console.log("accuracy ranges length:", this._accuracyRanges.length);
    // If we're offline, there's nothing to look into; use the DB.
    if (!this._account.universe.online) {
      existingDataGood = true;
    }
    else if (this._accuracyRanges.length && !forceDeepening) {
      ainfo = this._accuracyRanges[0];
console.log("type", this.folderMeta.type, "ainfo", JSON.stringify(ainfo));
      var newestMessage = this.getYoungestMessageTimestamp();
      var refreshThresh;
      if (this.folderMeta.type === 'inbox')
        refreshThresh = SYNC_REFRESH_USABLE_DATA_TIME_THRESH_INBOX;
      else if (ON_OR_BEFORE(newestMessage,
                            now - SYNC_REFRESH_USABLE_DATA_OLD_IS_SAFE_THRESH))
        refreshThresh = SYNC_REFRESH_USABLE_DATA_TIME_THRESH_OLD;
      else
        refreshThresh = SYNC_REFRESH_USABLE_DATA_TIME_THRESH_NON_INBOX;

      // We can do the refresh thing if we have updated more recently than
      // the cutoff threshold.
console.log("FSC", ainfo.fullSync && ainfo.fullSync.updated, now - refreshThresh);
      if (ainfo.fullSync &&
          SINCE(ainfo.fullSync.updated, now - refreshThresh)) {
        existingDataGood = true;
      }
      // Look into using an adjusted date range.
      else {
        var rangeThresh;
        if (this.folderMeta.type === 'inbox')
          rangeThresh = SYNC_USE_KNOWN_DATE_RANGE_TIME_THRESH_INBOX;
        else
          rangeThresh = SYNC_USE_KNOWN_DATE_RANGE_TIME_THRESH_NON_INBOX;

console.log("RTC", ainfo.fullSync && ainfo.fullSync.update, now - rangeThresh);
        if (ainfo.fullSync && SINCE(ainfo.fullSync.updated, now - rangeThresh)){
          // METHOD #2
          // We need to iterate over the headers to figure out the right
          // date to use.  We can't just use the accuracy range because it may
          // have been bisected by the user scrolling into the past and
          // triggering a refresh.
          this.getMessagesBeforeMessage(
            null, null, INITIAL_FILL_SIZE - 1,
            function(headers, moreExpected) {
              if (moreExpected)
                return;
              var header = headers[headers.length - 1];
              pastDate = quantizeDate(header.date);
              this._startSync(slice, pastDate, futureNow, 'sync', true);
            }.bind(this));
          return;
        }
      }
    }

    // -- Good existing data, fill the slice from the DB
    if (existingDataGood) {
      // We can adjust our start time to the dawn of time since we have a
      // limit in effect.
      slice.waitingOnData = 'db';
      // METHOD #1
      this.getMessagesInImapDateRange(
        0, futureNow, INITIAL_FILL_SIZE, INITIAL_FILL_SIZE,
        // trigger a refresh if we are online
        this.onFetchDBHeaders.bind(this, slice, this._account.universe.online));
      return;
    }

    // -- Bad existing data, issue a sync and have the slice
    // METHOD #3
    this._startSync(slice, pastDate, futureNow, 'sync', false);
  },

  _startSync: function ifs__startSync(slice, startTS, endTS, syncMode,
                                      accumulateMode) {
    if (startTS === null)
      startTS = endTS - (INITIAL_SYNC_DAYS * DAY_MILLIS);
    slice.setStatus('synchronizing', false, true);
    slice.waitingOnData = syncMode;
console.log("accumulate request", accumulateMode);
    if (accumulateMode && slice.headers.length === 0) {
console.log("ACCUMULATE MODE ON");
      slice._accumulating = true;
    }
    this._curSyncSlice = slice;
    this._curSyncAccuracyStamp = TIME_WARPED_NOW || Date.now();
    this._curSyncStartTS = startTS;
    this._curSyncDayStep = INITIAL_SYNC_DAYS;
    this._curSyncDoNotGrowWindowBefore = null;
    this.folderConn.syncDateRange(startTS, endTS, this._curSyncAccuracyStamp,
                                  null, this.onSyncCompleted.bind(this));
  },

  /**
   * The slice wants more headers.  Grab from the database and/or sync as
   * appropriate to get more headers.  If there is a cost, require a user
   * request to perform the sync.  When growing in the more recent (negative)
   * direction, we never issue a sync because our sync is always started from
   * 'now' and everything in that direction is inherently recently sync'ed.
   *
   * There are two primary steps here, and they are short-circuiting:
   *
   * 1) Figure out what we already have synchronized "in the can".  Count out
   * the requested number of headers (or as many as we have), then issue a sync
   * to cover the time range that includes that message.  This will be faster
   * than growing our time range since it is largely a delta check.  We then
   * stop, and leave the caller to re-issue a request to trigger #2.
   *
   * 2) Issue a sync request for a fresh new time range, leaving it to
   * `onSyncCompleted` to keep searching further back in time as needed.
   *
   * Because IMAP sync happens on day boundaries, we do explicitly exclude any
   * date overlap from sync activity.
   */
  growSlice: function ifs_growSlice(slice, dirMagnitude, userRequestsGrowth) {
    var dir, desiredCount;
    if (dirMagnitude < 0) {
      dir = -1;
      desiredCount = -dirMagnitude;
      slice.desiredHeaders += desiredCount;

      // Request 'desiredCount' messages, provide them in a batch.
      this.getMessagesAfterMessage(
        slice.endTS, slice.endUID, desiredCount,
        function(headers, moreExpected) {
          slice.batchAppendHeaders(headers, 0, moreExpected);
        });
    }
    else {
      dir = 1;
      desiredCount = dirMagnitude;

      // The sync wants to be BEFORE the earliest day (which we are assuming
      // is fully synced based on our day granularity).
      var syncEndTS = quantizeDate(slice.startTS);

      var batchHeaders = [];
      // Process the oldest traversed message
      var gotMessages = function gotMessages(headers, moreExpected) {
        batchHeaders = batchHeaders.concat(headers);
        if (!moreExpected) {
          var syncStartTS = null;
          if (batchHeaders.length)
            syncStartTS = batchHeaders[batchHeaders.length - 1].date;

          if (syncStartTS) {
            // We are computing a SINCE value, so quantize (to midnight)
            syncStartTS = quantizeDate(syncStartTS);
            // If we're not syncing at least one day, flag to give up.
            if (syncStartTS === syncEndTS)
              syncStartTS = null;
          }

          // If we're offline, just use what we've got and be done with it.
          if (!this._account.universe.online) {
            // (Yes this logic is the same as cases below, but I allege the
            // 'if' statement might be simpler this way.)
            if (batchHeaders.length) {
              slice.batchAppendHeaders(batchHeaders, -1, false);
              slice.desiredHeaders = slice.headers.length;
            }
            else {
              slice.sendEmptyCompletion();
            }
          }
          // Perform the sync if there is a range.
          else if (syncStartTS) {
            slice.desiredHeaders += desiredCount;
            // Perform a limited synchronization; do not issue additional
            // syncs!
            this._startSync(slice, syncStartTS, syncEndTS, 'limsync');
          }
          // If there is no sync range (left), but there were messsages, report
          // the messages.
          else if (batchHeaders.length) {
            slice.batchAppendHeaders(batchHeaders, -1, false);
            slice.desiredHeaders = slice.headers.length;
          }
          // If growth was requested/is allowed or our accuracy range already
          // covers as far back as we go, issue a (potentially expanding) sync.
          else if (userRequestsGrowth) {
            slice.desiredHeaders += desiredCount;
            this._startSync(slice, null, slice.startTS, 'sync');
          }
          // We are at the 'bottom', as it were.  Send an empty set.
          else {
            slice.sendEmptyCompletion();
          }
        }
      };

      // Iterate up to 'desiredCount' messages into the past, compute the sync
      // range, subtracting off the already known sync'ed range.
      this.getMessagesBeforeMessage(slice.startTS, slice.startUID,
                                    desiredCount, gotMessages.bind(this));
    }
  },

  /**
   * Refresh our understanding of the time range covered by the messages
   * contained in the slice, plus expansion to the bounds of our known sync
   * date boundaries if the messages are the first/last known message.
   *
   * In other words, if the most recently known message is from a week ago and
   * that is the most recent message the slice is displaying, then we will
   * expand our sync range to go all the way through today.  Likewise, if the
   * oldest known message is from two weeks ago and is in the slice, but we
   * scanned for messages all the way back to 1990 then we will query all the
   * way back to 1990.  And if we have no messages in the slice, then we use the
   * full date bounds.
   */
  refreshSlice: function ifs_refreshSlice(slice, useBisectLimit) {
    var startTS = slice.startTS, endTS = slice.endTS, self = this;

    // - Grow endTS
    // If the endTS lines up with the most recent know message for the folder,
    // then remove the timestamp constraint so it goes all the way to now.
    // OR if we just have no known messages
    if (this.headerIsYoungestKnown(endTS, slice.endUID)) {
console.log("growing endTS from", endTS, "to nowish");
      endTS = FUTURE_TIME_WARPED_NOW || null;
    }
    else {
      // We want the range to include the day; since it's an exclusive range
      // quantized to midnight, we need to adjust forward a day and then
      // quantize.
      endTS = quantizeDate(endTS - DAY_MILLIS);
    }

    // - Grow startTS
    // Grow the start-stamp to include the oldest continuous accuracy range
    // coverage date.
    if (this.headerIsOldestKnown(startTS, slice.startUID)) {
      var syncStartTS = this.getOldestFullSyncDate(startTS);
if (syncStartTS !== startTS)
console.log("growing startTS to", syncStartTS, "from", startTS);
      startTS = syncStartTS;
    }
    // quantize the start date
    startTS = quantizeDate(startTS);

    // XXX use mutex scheduling to avoid this possibly happening...
    if (this._curSyncSlice)
      throw new Error("Can't refresh a slice when there is an existing sync");
    slice.waitingOnData = 'refresh';
    this._curSyncAccuracyStamp = TIME_WARPED_NOW || Date.now();
    this.folderConn.syncDateRange(
      startTS, endTS, this._curSyncAccuracyStamp, useBisectLimit,
      function(bisectInfo, numMessages) {
        // If a bisection occurred then this can no longer be a refresh and
        // instead we need to retract all known messages and instead convert
        // this into a synchronization.
        if (bisectInfo) {
          if (bisectInfo === 'aborted') {
            self._slices.splice(self._slices.indexOf(slice), 1);
            self.sliceOpenFromNow(slice, null, true);
           }
          else {
            slice._resetHeadersBecauseOfRefreshExplosion();
          }
          return 'abort';
        }

        slice.waitingOnData = false;
        if (self._curSyncSlice === slice)
          self._curSyncSlice = null;
        self._account.__checkpointSyncCompleted();
        slice.setStatus('synced', true, false);
        return undefined;
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
  onSyncCompleted: function ifs_onSyncCompleted(bisectInfo, messagesSeen) {
    // In the event the time range had to be bisected, update our info so if
    // we need to take another step we do the right thing.
    if (bisectInfo) {
      this._curSyncDoNotGrowWindowBefore = bisectInfo.oldStartTS;
      this._curSyncDayStep = bisectInfo.dayStep;
      this._curSyncStartTS = bisectInfo.newStartTS;
      return;
    }

    console.log("Sync Completed!", this._curSyncDayStep, "days",
                messagesSeen, "messages synced");

    // If it now appears we know about all the messages in the folder, then we
    // are done syncing and can mark the entire folder as synchronized.  This
    // requires that the number of messages we know about is the same as the
    // number the server most recently told us are in the folder, plus that the
    // slice's oldest know message is the oldest message known to the db,
    // implying that we have fully synchronized the folder during this session.
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
        dbCount = this.getKnownMessageCount();
console.log("folder message count", folderMessageCount,
            "dbCount", dbCount,
            "oldest known", this.headerIsOldestKnown(this._curSyncSlice.startTS,
                                 this._curSyncSlice.startUID));
    if (folderMessageCount === dbCount &&
        this.headerIsOldestKnown(this._curSyncSlice.startTS,
                                 this._curSyncSlice.startUID)) {
      // (do not desire more headers)
      this._curSyncSlice.desiredHeaders = this._curSyncSlice.headers.length;
      // expand the accuracy range to cover everybody
      this.markSyncedEntireFolder();
    }
    // If our slice has now gone to the dawn of time, we can decide we have
    // enough headers.
    else if (this._curSyncSlice.startTS &&
             ON_OR_BEFORE(this._curSyncSlice.startTS, OLDEST_SYNC_DATE)) {
      this._curSyncSlice.desiredHeaders = this._curSyncSlice.headers.length;
    }

    // - Done if we don't want any more headers.
    if (this._curSyncSlice.headers.length >=
          this._curSyncSlice.desiredHeaders ||
        // (limited syncs aren't allowed to expand themselves)
        (this._curSyncSlice.waitingOnData === 'limsync')) {
      console.log("SYNCDONE Enough headers retrieved.",
                  "have", this._curSyncSlice.headers.length,
                  "want", this._curSyncSlice.desiredHeaders,
                  "box knows about", this.folderConn.box.messages.total,
                  "sync date", this._curSyncStartTS,
                  "[oldest defined as", OLDEST_SYNC_DATE, "]");
      // If we are accumulating, we don't want to adjust our count upwards;
      // the release will slice the excess off for us.
      if (!this._curSyncSlice._accumulating)
        this._curSyncSlice.desiredHeaders = this._curSyncSlice.headers.length;
      this._curSyncSlice.waitingOnData = false;
      this._curSyncSlice.setStatus('synced', true, false, true);
      this._curSyncSlice = null;

      this._account.__checkpointSyncCompleted();
      return;
    }
    else if (this._curSyncSlice._accumulating) {
      this._curSyncSlice.setStatus('synchronizing', true, true, true);
    }

    // - Increase our search window size if we aren't finding anything
    // Our goal is that if we are going backwards in time and aren't finding
    // anything, we want to keep expanding our window
    var daysToSearch, lastSyncDaysInPast;
    // If we saw messages, there is no need to increase the window size.  We
    // also should not increase the size if we explicitly shrank the window and
    // left a do-not-expand-until marker.
    if (messagesSeen ||
        (this._curSyncDoNotGrowWindowBefore !== null &&
         SINCE(this._curSyncStartTS, this._curSyncDoNotGrowWindowBefore))) {
      daysToSearch = this._curSyncDayStep;
    }
    else {
      // This may be a fractional value because of DST
      lastSyncDaysInPast = ((quantizeDate(TIME_WARPED_NOW || Date.now())) -
                            this._curSyncStartTS) / DAY_MILLIS;
      daysToSearch = Math.ceil(this._curSyncDayStep *
                               TIME_SCALE_FACTOR_ON_NO_MESSAGES);

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
    var startTS = makeDaysBefore(this._curSyncStartTS, daysToSearch),
        endTS = this._curSyncStartTS;
    this._curSyncStartTS = startTS;
    this.folderConn.syncDateRange(startTS, endTS, this._curSyncAccuracyStamp,
                                  null, this.onSyncCompleted.bind(this));
  },

  /**
   * Receive messages directly from the database (streaming).
   */
  onFetchDBHeaders: function(slice, triggerRefresh,
                             headers, moreMessagesComing) {
    slice.atBottom = this.headerIsOldestKnown(slice.endTS, slice.endUID);

    var triggerNow = false;
    if (!moreMessagesComing && triggerRefresh) {
      moreMessagesComing = true;
      triggerNow = true;
    }

    if (headers.length) {
      slice.batchAppendHeaders(headers, -1, moreMessagesComing);
    }

    if (!moreMessagesComing) {
      slice.desiredHeaders = slice.headers.length;
      slice.setStatus('synced', true, false);
      slice.waitingOnData = false;
    }
    else if (triggerNow) {
      slice.desiredHeaders = slice.headers.length;
      // refreshSlice expects this to be null for two reasons:
      // 1) Invariant about only having one sync-like thing happening at a time.
      // 2) We want to generate header deltas rather than initial filling,
      //    and this is keyed off of whether the slice is the current sync
      //    slice.
      this._curSyncSlice = null;
      // We do want to use the bisection limit so that the refresh gets
      // converted to a sync in the event of an overflow.
      this.refreshSlice(slice, SYNC_BISECT_DATE_AT_N_MESSAGES);
    }
  },

  sliceQuicksearch: function ifs_sliceQuicksearch(slice, searchParams) {
  },

  getYoungestMessageTimestamp: function() {
    if (!this._headerBlockInfos.length)
      return 0;
    return this._headerBlockInfos[0].endTS;
  },

  /**
   * Return true if the identified header is the most recent known message for
   * this folder as part of our fully-synchronized time-span.  Messages known
   * because of sparse searches do not count.  If null/null is passed and there
   * are no known headers, we will return true.
   */
  headerIsYoungestKnown: function(date, uid) {
    // NB: unlike oldest known, this should not actually be impacted by messages
    // found by search.
    if (!this._headerBlockInfos.length)
      return (date === null && uid === null);

    var blockInfo = this._headerBlockInfos[0];
    return (date === blockInfo.endTS &&
            uid === blockInfo.endUID);
  },

  /**
   * Return true if the identified header is the oldest known message for this
   * folder as part of our fully-synchronized time-span.  Messages known because
   * of sparse searches do not count.  If null/null is passed and there are no
   * known headers, we will return true.
   */
  headerIsOldestKnown: function(date, uid) {
    // TODO: when we implement search, this logic will need to be more clever
    // to check our full-sync range since we may indeed have cached messages
    // from way in the past.
    if (!this._headerBlockInfos.length)
      return (date === null && uid === null);

    var blockInfo = this._headerBlockInfos[this._headerBlockInfos.length - 1];
    return (date === blockInfo.startTS &&
            uid === blockInfo.startUID);
  },

  /**
   * What is the oldest date we have fully synchronized through per our
   * accuracy information?
   */
  getOldestFullSyncDate: function() {
    var idxAR = 0;
    // Run backward in time until we find one without a fullSync or run out
    while (idxAR < this._accuracyRanges.length &&
           this._accuracyRanges[idxAR].fullSync) {
      idxAR++;
    }
    // Decrement because the point is we went one too far.
    idxAR--;
    // Sanity-check, use.
    var syncTS;
    if (idxAR >= 0 && idxAR < this._accuracyRanges.length)
      syncTS = this._accuracyRanges[idxAR].startTS;
    else
      syncTS = TIME_WARPED_NOW || Date.now();
    return syncTS;
  },

  syncedToDawnOfTime: function() {
    var oldestSyncTS = this.getOldestFullSyncDate();
    return ON_OR_BEFORE(oldestSyncTS, OLDEST_SYNC_DATE);
  },

  /**
   * Tally and return the number of messages we believe to exist in the folder.
   */
  getKnownMessageCount: function() {
    var count = 0;
    for (var i = 0; i < this._headerBlockInfos.length; i++) {
      var blockInfo = this._headerBlockInfos[i];
      count += blockInfo.count;
    }
    return count;
  },

  /**
   * Retrieve the (ordered list) of messages covering a given IMAP-style date
   * range that we know about.  Use `getMessagesBeforeMessage` or
   * `getMessagesAfterMessage` to perform iteration relative to a known
   * message.
   *
   * @args[
   *   @param[startTS DateMS]{
   *     SINCE-evaluated start timestamp. (inclusive)
   *   }
   *   @param[endTS DateMS]{
   *     BEFORE-evaluated end timestamp. (exclusive)
   *   }
   *   @param[minDesired #:optional Number]{
   *     The minimum number of messages to return.  We will keep loading blocks
   *     from disk until this limit is reached.
   *   }
   *   @param[maxDesired #:optional Number]{
   *     The maximum number of messages to return.  If there are extra messages
   *     available in a header block after satisfying `minDesired`, we will
   *     return them up to this limit.
   *   }
   *   @param[messageCallback @func[
   *     @args[
   *       @param[headers @listof[HeaderInfo]]
   *       @param[moreMessagesComing Boolean]]
   *     ]
   *   ]
   * ]
   */
  getMessagesInImapDateRange: function ifs_getMessagesInDateRange(
      startTS, endTS, minDesired, maxDesired, messageCallback) {
    var toFill = (minDesired != null) ? minDesired : TOO_MANY_MESSAGES,
        maxFill = (maxDesired != null) ? maxDesired : TOO_MANY_MESSAGES,
        self = this,
        // header block info iteration
        iHeadBlockInfo = null, headBlockInfo;
    if (endTS == null)
      endTS = TIME_WARPED_NOW || Date.now(); // or just use a huge number?

    // find the first header block with the data we want
    var headerPair = this._findFirstObjIndexForDateRange(
                       this._headerBlockInfos, startTS, endTS);
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
        for (; iHeader < headerBlock.headers.length && maxFill;
             iHeader++, maxFill--) {
          header = headerBlock.headers[iHeader];
          if (BEFORE(header.date, startTS))
            break;
        }
        // (iHeader is pointing at the index of message we don't want)
        // There is no further processing to do if we bailed early.
        if (maxFill && iHeader < headerBlock.headers.length)
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
          if (STRICTLY_AFTER(startTS, headBlockInfo.endTS))
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
   * Batch/non-streaming version of `getMessagesInDateRange` using an IMAP
   * style date-range for syncing.
   *
   * @args[
   *   @param[allCallback @func[
   *     @args[
   *       @param[headers @listof[HeaderInfo]]
   *     ]
   *   ]
   * ]
   */
  getAllMessagesInImapDateRange: function ifs_getAllMessagesInDateRange(
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
    this.getMessagesInImapDateRange(startTS, endTS, null, null, someMessages);
  },

  /**
   * Fetch up to `limit` messages chronologically before the given message
   * (in the direction of 'start').
   *
   * If date/uid are null, it as if the date/uid of the most recent message
   * are passed.
   */
  getMessagesBeforeMessage: function(date, uid, limit, messageCallback) {
    var toFill = (limit != null) ? limit : TOO_MANY_MESSAGES, self = this;

    var headerPair, iHeadBlockInfo, headBlockInfo;
    if (date) {
      headerPair = this._findRangeObjIndexForDateAndUID(
                     this._headerBlockInfos, date, uid);
      iHeadBlockInfo = headerPair[0];
      headBlockInfo = headerPair[1];
    }
    else {
      iHeadBlockInfo = 0;
      headBlockInfo = this._headerBlockInfos[0];
    }

    if (!headBlockInfo) {
      // The iteration request is somehow not current; log an error and return
      // an empty result set.
      this._LOG.badIterationStart(date, uid);
      messageCallback([], false);
      return;
    }

    var iHeader = null;
    function fetchMore() {
      while (true) {
        // - load the header block if required
        if (!self._headerBlocks.hasOwnProperty(headBlockInfo.blockId)) {
          self._loadBlock('header', headBlockInfo.blockId, fetchMore);
          return;
        }
        var headerBlock = self._headerBlocks[headBlockInfo.blockId];

        // Null means find it by uid...
        if (iHeader === null) {
          if (uid !== null)
            iHeader = headerBlock.uids.indexOf(uid);
          else
            iHeader = 0;
          if (iHeader === -1) {
            self._LOG.badIterationStart(date, uid);
            toFill = 0;
          }
          iHeader++;
        }
        // otherwise we know we are starting at the front of the block.
        else {
          iHeader = 0;
        }

        var useHeaders = Math.min(
              headerBlock.headers.length - iHeader,
              toFill);
        if (iHeader >= headerBlock.headers.length)
          useHeaders = 0;
        toFill -= useHeaders;

        // If there's nothing more to...
        if (!toFill) {
        }
        // - There may be viable messages in the next block, check.
        else if (++iHeadBlockInfo >= self._headerBlockInfos.length) {
          // Nope, there are no more messages, nothing left to do.
          toFill = 0;
        }
        else {
          headBlockInfo = self._headerBlockInfos[iHeadBlockInfo];
        }
        // generate the notifications for what we did create
        messageCallback(headerBlock.headers.slice(iHeader,
                                                  iHeader + useHeaders),
                        Boolean(toFill));
        if (!toFill)
          return;
        // (there must be some overlap, keep going)
      }
    }

    fetchMore();
  },

  /**
   * Fetch up to `limit` messages chronologically after the given message (in
   * the direction of 'end').
   */
  getMessagesAfterMessage: function(date, uid, limit, messageCallback) {
    var toFill = (limit != null) ? limit : TOO_MANY_MESSAGES, self = this;

    var headerPair = this._findRangeObjIndexForDateAndUID(
                       this._headerBlockInfos, date, uid);
    var iHeadBlockInfo = headerPair[0];
    var headBlockInfo = headerPair[1];

    if (!headBlockInfo) {
      // The iteration request is somehow not current; log an error and return
      // an empty result set.
      this._LOG.badIterationStart(date, uid);
      messageCallback([], false);
      return;
    }

    var iHeader = null;
    function fetchMore() {
      while (true) {
        // - load the header block if required
        if (!self._headerBlocks.hasOwnProperty(headBlockInfo.blockId)) {
          self._loadBlock('header', headBlockInfo.blockId, fetchMore);
          return;
        }
        var headerBlock = self._headerBlocks[headBlockInfo.blockId];

        // Null means find it by uid...
        if (iHeader === null) {
          iHeader = headerBlock.uids.indexOf(uid);
          if (iHeader === -1) {
            self._LOG.badIterationStart(date, uid);
            toFill = 0;
          }
          iHeader--;
        }
        // otherwise we know we are starting at the end of the block (and
        // moving towards the front)
        else {
          iHeader = headerBlock.headers.length - 1;
        }

        var useHeaders = Math.min(iHeader + 1, toFill);
        if (iHeader < 0)
          useHeaders = 0;
        toFill -= useHeaders;

        // If there's nothing more to...
        if (!toFill) {
        }
        // - There may be viable messages in the previous block, check.
        else if (--iHeadBlockInfo < 0) {
          // Nope, there are no more messages, nothing left to do.
          toFill = 0;
        }
        else {
          headBlockInfo = self._headerBlockInfos[iHeadBlockInfo];
        }
        // generate the notifications for what we did create
        var messages = headerBlock.headers.slice(iHeader - useHeaders + 1,
                                                 iHeader + 1);
        messageCallback(messages, Boolean(toFill));
        if (!toFill)
          return;
        // (there must be some overlap, keep going)
      }
    }

    fetchMore();
  },


  /**
   * Mark a given time range as synchronized.
   *
   * @args[
   *   @param[startTS DateMS]
   *   @param[endTS DateMS]
   *   @param[modseq]
   *   @param[updated DateMS]
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
   * Mark that the most recent sync has now fully synchronized the folder.  We
   * do this when message counts tell us we know about every message in the
   * folder.
   */
  markSyncedEntireFolder: function() {
    // We can just expand the first accuracy range structure to stretch to the
    // dawn of time and nuke the rest.
    var aranges = this._accuracyRanges;
    // (If aranges is the empty list, there are deep invariant problems and
    // the exception is desired.)
    aranges[0].startTS = OLDEST_SYNC_DATE - 1;
    aranges.splice(1, aranges.length - 1);
  },

  /**
   * Add a new message to the database, generating slice notifications.
   */
  addMessageHeader: function ifs_addMessageHeader(header) {
    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.addMessageHeader.bind(this, header));
      return;
    }

    if (this._curSyncSlice)
      this._curSyncSlice.onHeaderAdded(header, true);
    // - Generate notifications for (other) interested slices
    if (this._slices.length > (this._curSyncSlice ? 1 : 0)) {
      var date = header.date, uid = header.id;
      for (var iSlice = 0; iSlice < this._slices.length; iSlice++) {
        var slice = this._slices[iSlice];

        if (slice === this._curSyncSlice)
          continue;
        // We never automatically grow a slice into the past, so bail on that.
        if (BEFORE(date, slice.startTS))
          continue;
        // We do grow a slice into the present if it's already up-to-date...
        if (SINCE(date, slice.endTS)) {
          // !(covers most recently known message)
          if(!(this._headerBlockInfos.length &&
               slice.endTS === this._headerBlockInfos[0].endTS &&
               slice.endUID === this._headerBlockInfos[0].endUID))
            continue;
        }
        else if ((date === slice.startTS &&
                  uid < slice.startUID) ||
                 (date === slice.endTS &&
                  uid > slice.endUID)) {
          continue;
        }
        slice.onHeaderAdded(header, false);
      }
    }


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
        self._curSyncSlice.onHeaderAdded(header, false);
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
      this._curSyncSlice.onHeaderAdded(header, true);
  },

  deleteMessageHeaderAndBody: function(header) {
    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.deleteMessageHeaderAndBody.bind(this,
                                                                    header));
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
   * Add a message body to the system; you must provide the header associated
   * with the body.
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

  /**
   * Update a message body; this should only happen because of attachments /
   * related parts being downloaded or purged from the system.
   *
   * Right now it is assumed/required that this body was retrieved via
   * getMessageBody while holding a mutex so that the body block must still
   * be around in memory.
   */
  updateMessageBody: function(suid, date, bodyInfo) {
    var uid = suid.substring(suid.lastIndexOf('/') + 1),
        posInfo = this._findRangeObjIndexForDateAndUID(this._bodyBlockInfos,
                                                       date, uid);
    var bodyBlockInfo = posInfo[1],
        block = this._bodyBlocks[bodyBlockInfo.blockId];
    block.bodies[uid] = bodyInfo;
    this._dirty = true;
    this._dirtyBodyBlocks[bodyBlockInfo.blockId] = block;
  },

  shutdown: function() {
    // reverse iterate since they will remove themselves as we kill them
    for (var i = this._slices.length - 1; i >= 0; i--) {
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
      // For now, logging date and uid is useful because the general logging
      // level will show us if we are trying to redundantly delete things.
      // Also, date and uid are opaque identifiers with very little entropy
      // on their own.  (The danger is in correlation with known messages,
      // but that is likely to be useful in the debugging situations where logs
      // will be sufaced.)
      deleteFromBlock: { type: false, date: false, uid: false },

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
      // Exposing date/uid at a general level is deemed okay because they are
      // opaque identifiers and the most likely failure models involve the
      // values being ridiculous (and therefore not legal).
      badIterationStart: { date: false, uid: false },
      badDeletionRequest: { type: false, date: false, uid: false },
      bodyBlockMissing: { uid: false, idx: false, dict: false },
    }
  },
}); // end LOGFAB

}); // end define

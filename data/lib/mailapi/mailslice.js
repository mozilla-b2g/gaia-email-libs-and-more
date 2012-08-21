define(
  [
    'rdcommon/log',
    './util',
    'module',
    'exports'
  ],
  function(
    $log,
    $util,
    $module,
    exports
  ) {
const bsearchForInsert = $util.bsearchForInsert,
      bsearchMaybeExists = $util.bsearchMaybeExists,
      cmpHeaderYoungToOld = $util.cmpHeaderYoungToOld;

var INITIAL_FILL_SIZE = 15;

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
function MailSlice(bridgeHandle, storage, _parentLog) {
  this._bridgeHandle = bridgeHandle;
  bridgeHandle.__listener = this;
  this._storage = storage;
  this._LOG = LOGFAB.MailSlice(this, _parentLog, bridgeHandle._handle);

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
exports.MailSlice = MailSlice;
MailSlice.prototype = {
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

    var idx = bsearchForInsert(this.headers, header, cmpHeaderYoungToOld);

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
    var idx = bsearchMaybeExists(this.headers, header, cmpHeaderYoungToOld);
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

    var idx = bsearchMaybeExists(this.headers, header, cmpHeaderYoungToOld);
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

var LOGFAB = exports.LOGFAB = $log.register($module, {
  MailSlice: {
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
}); // end LOGFAB

}); // end define

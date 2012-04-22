/**
 *
 **/

define(
  [
    'exports'
  ],
  function(
    exports
  ) {

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
 */
function ImapSlice(bridgeHandle, folder, folderStorage, dateRange, filters) {
}
ImapSlice.prototype = {
  setStatus: function(status) {
    this.bridgeHandle.sendStatus('status');
  },
};

const BASELINE_SEARCH_OPTIONS = ['!DRAFT'];

/**
 * What is the maximum number of bytes a block should store before we split
 * it.
 */
const MAX_BLOCK_SIZE = 96 * 1024,
/**
 * The estimated size of a `HeaderInfo` structure.  We are using a constant
 * since there is not a lot of variability in what we are storing and this
 * is probably good enough.
 */
      HEADER_EST_SIZE_IN_BYTES = 200;

const DAY_MILLIS = 24 * 60 * 60 * 1000;
/**
 * Make a timestamp some number of days in the past.
 */
function MakeDaysAgo(numDays) {
  var now = Date.now(),
      past = now - numDays * DAY_MILLIS;
  return past;
}

/**
 * How recent is recent enough for us to not have to talk to the server before
 * showing results?
 */
const RECENT_ENOUGH_TIME_THRESH = 6 * 60 * 60 * 1000;

/**
 * How many messages should we send to the UI in the first go?
 */
const INITIAL_FILL_SIZE = 12;

/**
 * Folder connections do the actual synchronization logic.  They are associated
 * with one or more `ImapSlice` instances that issue the requests that trigger
 * synchronization.  Storage is handled by `ImapFolderStorage` or
 * `GmailMessageStorage` instances.
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
function ImapFolderConn() {
  this._conn = null;

  this._activeTask = null;
  this._activeSlice = null;

  this._storage = null;
}
ImapFolderConn.prototype = {
  /**
   * Search with a guaranteed API.
   */
  _reliaSearch: function(searchOptions, callback) {
    this._conn.search(searchOptions, function(err, uids) {
        if (err) {
        }
      });
  },

  /**
   * Perform a search to find all the messages in the given date range.
   * Meanwhile, load the set of messages from storage.  Infer deletion of the
   * messages we already know about that should exist in the search results but
   * do not.  Retrieve information on the messages we don't know anything about
   * and update the metadata on the messages we do know about.
   */
  syncDateRange: function(youngerDate, olderDate, newToOld, slice) {
    var searchOptions = BASELINE_SEARCH_OPTIONS.concat(), self = this;
    if (youngerDate)
      searchOptions.push(['SINCE', youngerDate]);
    if (olderDate)
      searchOptions.push(['BEFORE', olderDate]);

    var fromDb = null;
    this.reliaSearch(searchOptions, function(uids) {

      });
    this._storage.getMessagesInDateRange(earlierDate, laterDate, syncer);
  },

  searchDateRange: function(youngerDate, olderDate, newToOld, searchParams,
                            slice) {
    var searchOptions = BASELINE_SEARCH_OPTIONS.concat(searchParams);
    if (youngerDate)
      searchOptions.push(['SINCE', youngerDate]);
    if (olderDate)
      searchOptions.push(['BEFORE', olderDate]);
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
 * are experiencing time pressure.
 *
 * Messages are discarded from storage
 *
 * @typedef[AccuracyRangeInfo @dict[
 *   @key[youngest DateMS]
 *   @key[oldest DateMS]
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
 *   @key[youngest DateMS]{
 *     The timestamp in milliseconds of the youngest message in the block where
 *     age/the timestamp is determined by the IMAP internaldate.
 *   }
 *   @key[oldest DateMS]{
 *     The timestamp in milliseconds of the oldest message in the block where
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
function ImapFolderStorage(folderId, persistedFolderInfo) {
  this._imapDb = null;

  this.folderId = folderId;
  /**
   * @listof[AccuracyRangeInfo]{
   *   Younged-to-oldest sorted list of accuracy range info structures.
   * }
   */
  this._accuracyRanges = persistedFolderInfo.accuracy;
  /**
   * @listof[FolderBlockInfo]{
   *   Youngest-to-oldest sorted list of header folder block infos.
   * }
   */
  this._headerBlockInfos = persistedFolderInfo.headerBlocks;
  /**
   * @listof[FolderBlockInfo]{
   *   Youngest-to-oldest sorted list of body folder block infos.
   * }
   */
  this._bodyBlockInfos = persistedFolderInfo.bodyBlocks;

  this._headerBlocks = {};
  this._bodyBlocks = {};

  this._dirtyHeaderBlocks = {};
  this._dirtyBodyBlocks = {};
}
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
      // Younger than the youngest?  Stop here.
      if (date > info.youngest)
        return [i, null];
      // Younger/as than the oldest (and older than the youngest)?  Stop here.
      if (date >= info.oldest)
        return [i, info];
      // (Older than the oldest, keep going.)
    }

    return [i, null];
  },

  /**
   * Find the first object that contains date ranges that overlaps the provided
   * date range.
   */
  _findFirstObjIndexForDateRange: function(list, youngerDate, olderDate) {
    var i;
    // linear scan for now; binary search later
    for (i = 0; i < list.length; i++) {
      var info = list[i];
      // Stop if our range is entirely more recent.
      if (youngerDate > info.youngest)
        return [i, null];
      // (the definition of overlap)
      if (youngerDate <= info.oldest &&
          olderDate >= info.youngest)
        return [i, info];
      // (no overlap yet)
    }

    return [i, null];
  },

  /**
   * Find the first object in the list whose `date` falls inside the given
   * date range.
   */
  _findFirstObjForDateRange: function(list, youngerDate, olderDate) {
    var i;
    for (i = 0; i < list.length; i++) {
      var date = list[i].date;
      if (date <= youngerDate &&
          date >= olderDate)
        return [i, list[i]];
    }
    return [i, null];
  },

  _loadHeaderBlock: function(blockId, callback) {
    // XXX we will either need to track pending loads or ensure that our
    // concurrency model forbids the potential for duplicate loads.
    this._imapDb.loadHeaderBlock(this.folderId, blockId);
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
    // -- Check if we have sufficiently useful data on hand.
    var now = Date.now(),
        pastDate = makeDaysAgo(daysDesired),
        iAcc, iHeadBlock, ainfo,
        // What is the oldest fullSync data we have for the time range?
        worstGoodData = null;
    for (iAcc = 0; iAcc < this._accuracyRanges.length; i++) {
      ainfo = this._accuracyRanges[iAcc];
      if (pastDate < ainfo.youngest)
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
   */
  getMessagesInDateRange: function(youngerDate, olderDate, limit,
                                   includeAccuracy, messageCallback) {
    var toFill = limit, self = this,
        // header block info iteration
        iHeadBlockInfo = null, headBlockInfo;


    // find the first header block with the data we want
    [iHeadBlockInfo, headBlockInfo] =
      self._findRangeObjIndexForDate(earlierDate, laterDate);
    if (!headBlockInfo) {
      // no blocks equals no messages.
      messageCallback(null, false);
      return;
    }

    function fetchMore() {
      while (true) {
        // - load the header block if required
        if (!(headBlockInfo.id in self._headerBlocks)) {
          self._loadHeaderBlock(headBlockInfo.id, fetchMore);
          return;
        }
        var headerBlock = self._headerBlocks[headblockInfo.id];
        // - use up as many headers in the block as possible
        var [iFirstHeader, header] = self._findFirstObjForDateRange(
                                       headerBlock.headers,
                                       youngerDate, olderDate);
        // aw man, no usable messages?!
        if (!header) {
          messageCallback(null, false);
          return;
        }
        // (at least one usable message)

        var iHeader = iFirstHeader;
        for (; toFill && iHeader < headerBlock.headers.length; iHeader++) {
          header = headerBlock.headers[iHeader];
          if (header.date < olderDate)
            break;
        }
        // (iHeader is pointing at the index of message we don't want)
        messageCallback(headerBlock.headers.slice(iFirstHeader, iHeader),
                        Boolean(toFill));
        // bail if there is nothing left to fill or we ran into an undesirable
        if (toFill || iHeader < headerBlock.headers.length)
          return;
        // - There may be viable messages in the next block, check.
        if (++iHeadBlockInfo >= self._headerBlockInfos.length)
          return;
        headBlockInfo = self._headerBlockInfos[iHeadBlockInfo];
        if (olderDate > headBlockInfo.youngest)
          return;
        // (there must be some overlap, keep going)
      }
    }

    fetchMore();
  },

  /**
   * Mark a given time range as synchronized.
   */
  markSyncRange: function(youngerDate, olderDate, modseq, dateMS) {
  },

  /**
   * Add a new message to the database, generating slice notifications.
   */
  addMessageHeader: function(date, uid, header) {
  },

  /**
   * Update an existing mesage header in the database, generating slice
   * notifications.
   */
  updateMessageHeader: function(date, uid, header) {
  },

  /**
   *
   */
  putMessageBody: function(date, uid, bodyInfo) {
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

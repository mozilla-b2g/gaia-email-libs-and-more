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
 * folders.  So we abstract away the storage details to `FolderStorage`.
 *
 * == Latency, offline access, and IMAP
 *
 * The fundamental trade-off is between delaying showing things in the UI and
 * showing them and then having a bunch of stuff happen a split-second later.
 * (Messages appearing, disappearing, having their status change, etc.)
 *
 **/

define(function(require, exports, module) {

var $log = require('rdcommon/log');
var slog = require('./slog');
var $util = require('./util');
var $a64 = require('./a64');
var $allback = require('./allback');
var $date = require('./date');
var $sync = require('./syncbase');

var bsearchForInsert = $util.bsearchForInsert,
    bsearchMaybeExists = $util.bsearchMaybeExists,
    cmpHeaderYoungToOld = $util.cmpHeaderYoungToOld,
    allbackMaker = $allback.allbackMaker,
    BEFORE = $date.BEFORE,
    ON_OR_BEFORE = $date.ON_OR_BEFORE,
    SINCE = $date.SINCE,
    STRICTLY_AFTER = $date.STRICTLY_AFTER,
    IN_BS_DATE_RANGE = $date.IN_BS_DATE_RANGE,
    HOUR_MILLIS = $date.HOUR_MILLIS,
    DAY_MILLIS = $date.DAY_MILLIS,
    NOW = $date.NOW,
    quantizeDate = $date.quantizeDate,
    quantizeDateUp = $date.quantizeDateUp;

var PASTWARDS = 1, FUTUREWARDS = -1;

// What do we think the post-snappy compression overhead of the structured clone
// persistence rep will be for various things?  These are total guesses right
// now.  Keep in mind we do want the pre-compression size of the data in all
// cases and we just hope it will compress a bit.  For the attributes we are
// including the attribute name as well as any fixed-overhead for its payload,
// especially numbers which may or may not be zig-zag encoded/etc.
var OBJ_OVERHEAD_EST = 2, STR_ATTR_OVERHEAD_EST = 5,
    NUM_ATTR_OVERHEAD_EST = 10, LIST_ATTR_OVERHEAD_EST = 4,
    NULL_ATTR_OVERHEAD_EST = 2, LIST_OVERHEAD_EST = 4,
    NUM_OVERHEAD_EST = 8, STR_OVERHEAD_EST = 4;

/**
 * Intersects two objects each defining tupled ranges of the type
 * { startTS, startUID, endTS, endUID }, like block infos and mail slices.
 * This is exported for unit testing purposes and because no state is closed
 * over.
 */
var tupleRangeIntersectsTupleRange = exports.tupleRangeIntersectsTupleRange =
    function tupleRangeIntersectsTupleRange(a, b) {
  if (BEFORE(a.endTS, b.startTS) ||
      STRICTLY_AFTER(a.startTS, b.endTS))
    return false;
  if ((a.endTS === b.startTS && a.endUID < b.startUID) ||
      (a.startTS === b.endTS && a.startTS > b.endUID))
    return false;
  return true;
};

/**
 * How much progress in the range [0.0, 1.0] should we report for just having
 * started the synchronization process?  The idea is that by having this be
 * greater than 0, our progress bar indicates that we are doing something or
 * at least know we should be doing something.
 */
var SYNC_START_MINIMUM_PROGRESS = 0.02;

/**
 * Book-keeping and limited agency for the slices.
 *
 * === Batching ===
 * Headers are removed, added, or modified using the onHeader* methods.
 * The updates are sent to 'SliceBridgeProxy' which batches updates and
 * puts them on the event loop. We batch so that we can minimize the number of
 * reflows and painting on the DOM side. This also enables us to batch data
 * received in network packets around the smae time without having to handle it in
 * each protocol's logic.
 *
 * Currently, we only batch updates that are done between 'now' and the next time
 * a zeroTimeout can fire on the event loop.  In order to keep the UI responsive,
 * We force flushes if we have more than 5 pending slices to send.
 */
function MailSlice(bridgeHandle, storage, _parentLog) {
  this._bridgeHandle = bridgeHandle;
  bridgeHandle.__listener = this;
  this._storage = storage;
  this._LOG = LOGFAB.MailSlice(this, _parentLog, bridgeHandle._handle);


  this.focalSUID = null;

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
   * If true, don't add any headers.  This is used by ActiveSync during its
   * synchronization step to wait until all headers have been retrieved and
   * then the slice is populated from the database.  After this initial sync,
   * ignoreHeaders is set to false so that updates and (hopefully small
   * numbers of) additions/removals can be observed.
   */
  this.ignoreHeaders = false;

  /**
   * @listof[HeaderInfo]
   */
  this.headers = [];
  this.desiredHeaders = $sync.INITIAL_FILL_SIZE;

  this.headerCount = storage.headerCount;
}
exports.MailSlice = MailSlice;
MailSlice.prototype = {
  /**
   * We are a folder-backed view-slice.
   */
  type: 'folder',

  set atTop(val) {
    if (this._bridgeHandle)
      this._bridgeHandle.atTop = val;
    return val;
  },
  set atBottom(val) {
    if (this._bridgeHandle)
      this._bridgeHandle.atBottom = val;
    return val;
  },
  set userCanGrowUpwards(val) {
    if (this._bridgeHandle)
      this._bridgeHandle.userCanGrowUpwards = val;
    return val;
  },
  set userCanGrowDownwards(val) {
    if (this._bridgeHandle)
      this._bridgeHandle.userCanGrowDownwards = val;
    return val;
  },
  set headerCount(val) {
    if (this._bridgeHandle)
      this._bridgeHandle.headerCount = val;
    return val;
  },

  _updateSliceFlags: function() {
    var flagHolder = this._bridgeHandle;
    flagHolder.atTop = this._storage.headerIsYoungestKnown(this.endTS,
                                                           this.endUID);
    flagHolder.atBottom = this._storage.headerIsOldestKnown(this.startTS,
                                                            this.startUID);
    if (flagHolder.atTop)
      flagHolder.userCanGrowUpwards = !this._storage.syncedToToday();
    else
      flagHolder.userCanGrowUpwards = false;

    if (flagHolder.atBottom)
      flagHolder.userCanGrowDownwards = !this._storage.syncedToDawnOfTime();
    else
      flagHolder.userCanGrowDownwards = false;
  },

  /**
   * Reset the state of the slice, clearing out any known headers.
   */
  reset: function() {
    if (!this._bridgeHandle)
      return;

    if (this.headers.length) {
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
    if (!this._bridgeHandle)
      return;

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
      this.userCanGrowUpwards = false;
      this.desiredHeaders -= firstIndex;
      this._bridgeHandle.sendSplice(0, firstIndex, [], true, false);
      this.headers.splice(0, firstIndex);
      var firstHeader = this.headers[0];
      this.endTS = firstHeader.date;
      this.endUID = firstHeader.id;
    }

    this._storage.sliceShrunk(this);
  },

  reqGrow: function(dirMagnitude, userRequestsGrowth) {
    if (dirMagnitude === -1)
      dirMagnitude = -$sync.INITIAL_FILL_SIZE;
    else if (dirMagnitude === 1)
      dirMagnitude = $sync.INITIAL_FILL_SIZE;
    this._storage.growSlice(this, dirMagnitude, userRequestsGrowth);
  },

  sendEmptyCompletion: function() {
    this.setStatus('synced', true, false);
  },

  setStatus: function(status, requested, moreExpected, flushAccumulated,
                      progress, newEmailCount) {
    if (!this._bridgeHandle)
      return;

    switch (status) {
      case 'synced':
      case 'syncfailed':
        this._updateSliceFlags();
        break;
    }
    this._bridgeHandle.sendStatus(status, requested, moreExpected, progress,
                                    newEmailCount);
  },

  /**
   * Update our sync progress with a value in the range [0.0, 1.0].  We leave
   * it up to the specific protocol to determine how it maps values.
   */
  setSyncProgress: function(value) {
    if (!this._bridgeHandle)
      return;
    this._bridgeHandle.sendSyncProgress(value);
  },

  /**
   * @args[
   *   @param[headers @listof[MailHeader]]
   *   @param[insertAt @oneof[
   *     @case[-1]{
   *       Append to the end of the list
   *     }
   *     @case[Number]{
   *       Insert the headers at the given index.
   *     }
   *   ]]
   *   @param[moreComing Boolean]
   * ]
   */
  batchAppendHeaders: function(headers, insertAt, moreComing) {
    if (!this._bridgeHandle)
      return;

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
    this._bridgeHandle.sendSplice(insertAt, 0, headers,
                                  true, moreComing);
  },

  /**
   * Tell the slice about a header it should be interested in.  This should
   * be unconditionally called by a sync populating this slice, or conditionally
   * called when the header is in the time-range of interest and a refresh,
   * cron-triggered sync, or IDLE/push tells us to do so.
   */
  onHeaderAdded: function(header, body, syncDriven, messageIsNew) {
    if (!this._bridgeHandle)
      return;

    var idx = bsearchForInsert(this.headers, header, cmpHeaderYoungToOld);
    var hlen = this.headers.length;
    // Don't append the header if it would expand us beyond our requested
    // amount.  Note that this does not guarantee that we won't end up with more
    // headers than originally planned; if we get told about headers earlier
    // than the last slot, we will insert them and grow without forcing a
    // removal of something else to offset.
    if (hlen >= this.desiredHeaders && idx === hlen)
      return;
    // If we are inserting (not at the end) then be sure to grow
    // the number of desired headers to be consistent with the number of headers
    // we have.
    if (hlen >= this.desiredHeaders)
      this.desiredHeaders++;

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
    this._bridgeHandle.sendSplice(idx, 0, [header],
                                  Boolean(this.waitingOnData),
                                  Boolean(this.waitingOnData));
    this.headers.splice(idx, 0, header);
  },

  /**
   * Tells the slice that a header it should know about has changed.  (If
   * this is a search, it's okay for it not to know...)
   */
  onHeaderModified: function(header, body) {
    if (!this._bridgeHandle)
      return;

    // this can only affect flags which will not affect ordering
    var idx = bsearchMaybeExists(this.headers, header, cmpHeaderYoungToOld);
    if (idx !== null) {
      // There is no identity invariant to ensure this is already true.
      this.headers[idx] = header;
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

    var idx = bsearchMaybeExists(this.headers, header, cmpHeaderYoungToOld);
    if (idx !== null) {
      this._LOG.headerRemoved(idx, header);
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
    this.desiredHeaders = 0;
    this._storage.dyingSlice(this);
    this._LOG.__die();
  },

  get isDead() {
    return this._bridgeHandle === null;
  },
};


/**
 * Folder version history:
 *
 * v3: Unread count tracking fixed, so we need to re-run it.
 *
 * v2: Initial unread count tracking.  Regrettably with bad maths.
 */
var FOLDER_DB_VERSION = exports.FOLDER_DB_VERSION = 3;

/**
 * Legacy abstraction fire sale.  ALL USEFUL METHODS MUST GO (someplace else)!
 *
 * Expected useful things to migrate:
 * - metadata stuff like isLocalOnly
 *
 * Where are things going?:
 * - metadata probably can still just stay something the account manages?
 * - folder_sync_db.js stores the actual per-folder sync state
 * - folder_convs_toc.js powers the view-slice for conversations in a folder
 * - sync logic all gets migrated to reasonably-sized tasks/sync*.js tasks
 * - syncs are triggered by explicitly scheduling the relevant tasks in trivial
 *   helper methods on the account which are triggered by the bridge command
 *   implementations as a reasonable side-effect (slice opening), or explicit
 *   request that also has a sugared helper on the specific slice sub-class in
 *   the front-end.
 */
function FolderStorage(account, folderId, persistedFolderInfo, dbConn,
                       FolderSyncer, _parentLog) {
  /** Our owning account. */
  this._account = account;
  this._imapDb = dbConn;

  this.folderId = folderId;
  this.folderMeta = persistedFolderInfo.$meta;
  this._folderImpl = persistedFolderInfo.$impl;

  this._LOG = LOGFAB.FolderStorage(this, _parentLog, folderId);


  /**
   * Active view / search slices on this folder.
   */
  this._slices = [];
}
exports.FolderStorage = FolderStorage;

FolderStorage.prototype = {
  get hasActiveSlices() {
    return this._slices.length > 0;
  },

  get isLocalOnly() {
    return FolderStorage.isTypeLocalOnly(this.folderMeta.type);
  },

  /**
   * Reset all active slices.
   */
  resetAndRefreshActiveSlices: function() {
    if (!this._slices.length)
      return;
    // This will splice out slices as we go, so work from the back to avoid
    // processing any slice more than once.  (Shuffling of processed slices
    // will occur, but we don't care.)
    for (var i = this._slices.length - 1; i >= 0; i--) {
      var slice = this._slices[i];
      slice.desiredHeaders = $sync.INITIAL_FILL_SIZE;
      slice.reset();
      if (slice.type === 'folder') {
        this._resetAndResyncSlice(slice, true, null);
      }
    }
  },

  sliceOpenSearch: function fs_sliceOpenSearch(slice) {
    this._slices.push(slice);
  },

  dyingSlice: function ifs_dyingSlice(slice) {
    var idx = this._slices.indexOf(slice);
    this._slices.splice(idx, 1);

    // If this was a folder-backed slice, we potentially can now free up a lot
    // of cached memory, so do that.
    if (slice.type === 'folder') {
      this.flushExcessCachedBlocks('deadslice');
    }

    if (this._slices.length === 0 && this._mutexQueue.length === 0) {
      this.folderSyncer.allConsumersDead();
    }
  },

  /**
   * Retrieve a full message (header/body) by suid & date. If either the body or
   * header is not present res will be null.
   *
   *    folderStorage.getMessage(suid, date, function(res) {
   *      if (!res) {
   *        // don't do anything
   *      }
   *
   *      res.header;
   *      res.body;
   *    });
   *
   */
  getMessage: function(suid, date, options, callback) {
    if (typeof(options) === 'function') {
      callback = options;
      options = undefined;
    }

    var header;
    var body;
    var pending = 2;

    function next() {
      if (!--pending) {
        if (!body || !header) {
          return callback(null);
        }

        callback({ header: header, body: body });
      }
    }

    this.getMessageHeader(suid, date, function(_header) {
      header = _header;
      next();
    });

    var gotBody = function gotBody(_body) {
      body = _body;
      next();
    };

    if (options && options.withBodyReps) {
      this.getMessageBodyWithReps(suid, date, gotBody);
    } else {
      this.getMessageBody(suid, date, gotBody);
    }
  },

  /**
   * Retrieve a message header by its SUID and date; you would do this if you
   * only had the SUID and date, like in a 'job'.
   */
  getMessageHeader: function ifs_getMessageHeader(suid, date, callback) {
    var id = parseInt(suid.substring(suid.lastIndexOf('.') + 1)),
        posInfo = this._findRangeObjIndexForDateAndID(this._headerBlockInfos,
                                                      date, id);

    if (posInfo[1] === null) {
      this._LOG.headerNotFound();
      try {
        callback(null);
      }
      catch (ex) {
        this._LOG.callbackErr(ex);
      }
      return;
    }
    var headerBlockInfo = posInfo[1], self = this;
    if (!(this._headerBlocks.hasOwnProperty(headerBlockInfo.blockId))) {
      this._loadBlock('header', headerBlockInfo, function(headerBlock) {
          var idx = headerBlock.ids.indexOf(id);
          var headerInfo = headerBlock.headers[idx] || null;
          if (!headerInfo)
            self._LOG.headerNotFound();
          try {
            callback(headerInfo);
          }
          catch (ex) {
            self._LOG.callbackErr(ex);
          }
        });
      return;
    }
    var block = this._headerBlocks[headerBlockInfo.blockId],
        idx = block.ids.indexOf(id),
        headerInfo = block.headers[idx] || null;
    if (!headerInfo)
      this._LOG.headerNotFound();
    try {
      callback(headerInfo);
    }
    catch (ex) {
      this._LOG.callbackErr(ex);
    }
  },

  /**
   * Retrieve multiple message headers.
   */
  getMessageHeaders: function ifs_getMessageHeaders(namers, callback) {
    var pending = namers.length;

    var headers = [];
    var gotHeader = function gotHeader(header) {
      if (header) {
        headers.push(header);
      }

      if (!--pending) {
        callback(headers);
      }
    };
    for (var i = 0; i < namers.length; i++) {
      var namer = namers[i];
      this.getMessageHeader(namer.suid, namer.date, gotHeader);
    }
  },

  /**
   * Add a new message to the database, generating slice notifications.
   *
   * @param header
   * @param [body]
   *   Optional body, exists to hint to slices so that SearchFilter can peek
   *   directly at the body without needing to make an additional request to
   *   look at the body.
   */
  addMessageHeader: function ifs_addMessageHeader(header, body, callback) {
    if (header.id == null || header.suid == null) {
      throw new Error('No valid id: ' + header.id + ' or suid: ' + header.suid);
    }

    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.addMessageHeader.bind(
                                 this, header, body, callback));
      return;
    }

    if (header.flags && header.flags.indexOf('\\Seen') === -1) {
      this.folderMeta.unreadCount++;
    }

    this._LOG.addMessageHeader(header.date, header.id, header.srvid);

    this.headerCount += 1;

    if (this._curSyncSlice) {
      // TODO: make sure the slice knows the true offset of its
      // first header in the folder. Currently the UI never
      // shrinks its slice so this number is always 0 and we can
      // get away without providing that offset for now.
      this._curSyncSlice.headerCount = this.headerCount;
      if (!this._curSyncSlice.ignoreHeaders) {
        this._curSyncSlice.onHeaderAdded(header, body, true, true);
      }
    }

    // - Generate notifications for (other) interested slices
    if (this._slices.length > (this._curSyncSlice ? 1 : 0)) {
      var date = header.date, uid = header.id;
      for (var iSlice = 0; iSlice < this._slices.length; iSlice++) {
        var slice = this._slices[iSlice];
        if (slice === this._curSyncSlice) {
          continue;
        }

        if (slice.type === 'folder') {
          // TODO: make sure the slice knows the true offset of its
          // first header in the folder. Currently the UI never
          // shrinks its slice so this number is always 0 and we can
          // get away without providing that offset for now.
          slice.headerCount = this.headerCount;
        }

        // Note: the following control flow is to decide when to bail; if we
        // make it through the conditionals, the header gets reported to the
        // slice.

        // (if the slice is empty, it cares about any header, so keep going)
        if (slice.startTS !== null) {
          // We never automatically grow a slice into the past if we are full,
          // but we do allow it if not full.
          if (BEFORE(date, slice.startTS)) {
            if (slice.headers.length >= slice.desiredHeaders) {
              continue;
            }
          }
          // We do grow a slice into the present if it's already up-to-date.
          // We do count messages from the same second as our
          else if (SINCE(date, slice.endTS)) {
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
        }
        else {
          // Make sure to increase the number of desired headers so the
          // truncating heuristic won't rule the header out.
          slice.desiredHeaders++;
        }

        if (slice._onAddingHeader) {
          try {
            slice._onAddingHeader(header);
          }
          catch (ex) {
            this._LOG.callbackErr(ex);
          }
        }

        try {
          slice.onHeaderAdded(header, body, false, true);
        }
        catch (ex) {
          this._LOG.callbackErr(ex);
        }
      }
    }


    this._insertIntoBlockUsingDateAndUID(
      'header', header.date, header.id, header.srvid,
      $sync.HEADER_EST_SIZE_IN_BYTES, header, callback);
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
   *
   * Options:
   *   { silent: true }
   *     Don't send slice updates. Used when updating an internal
   *     IMAP-specific flag (imapMissingInSyncRange: slices don't need
   *     to know about it) so that existing tests don't get mad that
   *     we're sending out extra updateMessageHeader events without
   *     expecting them. This flag should be removed in the test
   *     refactoring to allow more fine-grained control over
   *     onHeaderModified assertions.
   */
  updateMessageHeader: function ifs_updateMessageHeader(date, id, partOfSync,
                                                        headerOrMutationFunc,
                                                        body,
                                                        callback,
                                                        opts) {
    // (While this method can complete synchronously, we want to maintain its
    // perceived ordering relative to those that cannot be.)
    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.updateMessageHeader.bind(
                                 this, date, id, partOfSync,
                                 headerOrMutationFunc, body, callback));
      return;
    }

    // We need to deal with the potential for the block having been discarded
    // from memory thanks to the potential asynchrony due to pending loads or
    // on the part of the caller.
    var infoTuple = this._findRangeObjIndexForDateAndID(
                      this._headerBlockInfos, date, id),
        iInfo = infoTuple[0], info = infoTuple[1], self = this;
    function doUpdateHeader(block) {
      var idx = block.ids.indexOf(id), header;
      if (idx === -1) {
        // Call the mutation func with null to let it know we couldn't find the
        // header.
        if (headerOrMutationFunc instanceof Function)
          headerOrMutationFunc(null);
        else
          throw new Error('Failed to find ID ' + id + '!');
      }
      else if (headerOrMutationFunc instanceof Function) {
        // If it returns false it means that the header did not change and so
        // there is no need to mark anything dirty and we can leave without
        // notifying anyone.
        if (!headerOrMutationFunc((header = block.headers[idx])))
          header = null;
      }
      else {
        header = block.headers[idx] = headerOrMutationFunc;
      }
      // only dirty us and generate notifications if there is a header
      if (header) {
        self._dirty = true;
        self._dirtyHeaderBlocks[info.blockId] = block;

        self._LOG.updateMessageHeader(header.date, header.id, header.srvid);

        if (self._slices.length > (self._curSyncSlice ? 1 : 0)) {
          for (var iSlice = 0; iSlice < self._slices.length; iSlice++) {
            var slice = self._slices[iSlice];
            if (partOfSync && slice === self._curSyncSlice)
              continue;
            if (opts && opts.silent) {
              continue;
            }
            if (BEFORE(date, slice.startTS) ||
                STRICTLY_AFTER(date, slice.endTS))
              continue;
            if ((date === slice.startTS &&
                 id < slice.startUID) ||
                (date === slice.endTS &&
                 id > slice.endUID))
              continue;
            try {
              slice.onHeaderModified(header, body);
            }
            catch (ex) {
              this._LOG.callbackErr(ex);
            }
          }
        }
      }
      if (callback)
        callback();
    }
    if (!info) {
      if (headerOrMutationFunc instanceof Function)
        headerOrMutationFunc(null);
      else
        throw new Error('Failed to find block containing header with date: ' +
                        date + ' id: ' + id);
    }
    else if (!this._headerBlocks.hasOwnProperty(info.blockId))
      this._loadBlock('header', info, doUpdateHeader);
    else
      doUpdateHeader(this._headerBlocks[info.blockId]);
  },

  /**
   * Retrieve and update a header by locating it
   */
  updateMessageHeaderByServerId: function(srvid, partOfSync,
                                          headerOrMutationFunc, body,
                                          callback) {
    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.updateMessageHeaderByServerId.bind(
        this, srvid, partOfSync, headerOrMutationFunc, body, callback));
      return;
    }

    var blockId = this._serverIdHeaderBlockMapping[srvid];
    if (srvid === undefined) {
      this._LOG.serverIdMappingMissing(srvid);
      return;
    }

    var findInBlock = function findInBlock(headerBlock) {
      var headers = headerBlock.headers;
      for (var i = 0; i < headers.length; i++) {
        var header = headers[i];
        if (header.srvid === srvid) {
          // future work: this method will duplicate some work to re-locate
          // the header; we could try and avoid doing that.
          this.updateMessageHeader(
            header.date, header.id, partOfSync, headerOrMutationFunc, body,
            callback);
          return;
        }
      }
    }.bind(this);

    if (this._headerBlocks.hasOwnProperty(blockId)) {
      findInBlock(this._headerBlocks[blockId]);
    }
    else {
      var blockInfo = this._findBlockInfoFromBlockId('header', blockId);
      this._loadBlock('header', blockInfo, findInBlock);
    }
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
    if (this._curSyncSlice && !this._curSyncSlice.ignoreHeaders)
      this._curSyncSlice.onHeaderAdded(header, true, false);
  },

  hasMessageWithServerId: function(srvid) {
    if (!this._serverIdHeaderBlockMapping)
      throw new Error('Server ID mapping not supported for this storage!');

    var blockId = this._serverIdHeaderBlockMapping[srvid];
    if (srvid === undefined) {
      this._LOG.serverIdMappingMissing(srvid);
      return false;
    }

    return !!blockId;
  },

  deleteMessageHeaderAndBody: function(suid, date, callback) {
    this.getMessageHeader(suid, date, function(header) {
      if (header)
        this.deleteMessageHeaderAndBodyUsingHeader(header, callback);
      else
        callback();
    }.bind(this));
  },

  deleteMessageHeaderUsingHeader: function(header, callback) {
    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.deleteMessageHeaderUsingHeader.bind(
                               this, header, callback));
      return;
    }

    this.headerCount -= 1;

    if (this._curSyncSlice) {
      // TODO: make sure the slice knows the true offset of its
      // first header in the folder. Currently the UI never
      // shrinks its slice so this number is always 0 and we can
      // get away without providing that offset for now.
      this._curSyncSlice.headerCount = this.headerCount;
      // NB: ignoreHeaders should never be true if we are deleting headers, but
      // just doing this as a simple transform for equivalence purposes.
      // ignoreHeaders should go away.
      if (!this._curSyncSlice.ignoreHeaders) {
        this._curSyncSlice.onHeaderRemoved(header);
      }
    }
    if (this._slices.length > (this._curSyncSlice ? 1 : 0)) {
      for (var iSlice = 0; iSlice < this._slices.length; iSlice++) {
        var slice = this._slices[iSlice];

        if (slice.type === 'folder') {
          // TODO: make sure the slice knows the true offset of its
          // first header in the folder. Currently the UI never
          // shrinks its slice so this number is always 0 and we can
          // get away without providing that offset for now.
          slice.headerCount = this.headerCount;
        }

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

    if (this._serverIdHeaderBlockMapping && header.srvid)
      delete this._serverIdHeaderBlockMapping[header.srvid];

    this._deleteFromBlock('header', header.date, header.id, callback);
  },

  deleteMessageHeaderAndBodyUsingHeader: function(header, callback) {
    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.deleteMessageHeaderAndBodyUsingHeader.bind(
                               this, header, callback));
      return;
    }
    this.deleteMessageHeaderUsingHeader(header, function() {
      this._deleteFromBlock('body', header.date, header.id, callback);
    }.bind(this));
  },

  /**
   * Delete a message header and its body using only the server id for the
   * message.  This requires that `serverIdHeaderBlockMapping` was enabled.
   * Currently, the mapping is a naive, always-in-memory (at least as long as
   * the FolderStorage is in memory) map.
   */
  deleteMessageByServerId: function(srvid, callback) {
    if (!this._serverIdHeaderBlockMapping)
      throw new Error('Server ID mapping not supported for this storage!');

    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.deleteMessageByServerId.bind(this, srvid,
                                                                 callback));
      return;
    }

    var blockId = this._serverIdHeaderBlockMapping[srvid];
    if (srvid === undefined) {
      this._LOG.serverIdMappingMissing(srvid);
      return;
    }

    var findInBlock = function findInBlock(headerBlock) {
      var headers = headerBlock.headers;
      for (var i = 0; i < headers.length; i++) {
        var header = headers[i];
        if (header.srvid === srvid) {
          this.deleteMessageHeaderAndBodyUsingHeader(header, callback);
          return;
        }
      }
    }.bind(this);

    if (this._headerBlocks.hasOwnProperty(blockId)) {
      findInBlock(this._headerBlocks[blockId]);
    }
    else {
      var blockInfo = this._findBlockInfoFromBlockId('header', blockId);
      this._loadBlock('header', blockInfo, findInBlock);
    }
  },

  /**
   * Add a message body to the system; you must provide the header associated
   * with the body.
   */
  addMessageBody: function ifs_addMessageBody(header, bodyInfo, callback) {
    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.addMessageBody.bind(
                                 this, header, bodyInfo, callback));
      return;
    }
    this._LOG.addMessageBody(header.date, header.id, header.srvid, bodyInfo);

    // crappy size estimates where we assume the world is ASCII and so a UTF-8
    // encoding will take exactly 1 byte per character.
    var sizeEst = OBJ_OVERHEAD_EST + NUM_ATTR_OVERHEAD_EST +
                    4 * NULL_ATTR_OVERHEAD_EST;
    function sizifyAddrs(addrs) {
      sizeEst += LIST_ATTR_OVERHEAD_EST;
      if (!addrs)
        return;
      for (var i = 0; i < addrs.length; i++) {
        var addrPair = addrs[i];
        sizeEst += OBJ_OVERHEAD_EST + 2 * STR_ATTR_OVERHEAD_EST +
                     (addrPair.name ? addrPair.name.length : 0) +
                     (addrPair.address ? addrPair.address.length : 0);
      }
    }
    function sizifyAttachments(atts) {
      sizeEst += LIST_ATTR_OVERHEAD_EST;
      if (!atts)
        return;
      for (var i = 0; i < atts.length; i++) {
        var att = atts[i];
        sizeEst += OBJ_OVERHEAD_EST + 2 * STR_ATTR_OVERHEAD_EST +
                     att.name.length + att.type.length +
                     NUM_ATTR_OVERHEAD_EST;
      }
    }
    function sizifyStr(str) {
      sizeEst += STR_ATTR_OVERHEAD_EST + str.length;
    }
    function sizifyStringList(strings) {
      sizeEst += LIST_OVERHEAD_EST;
      if (!strings)
        return;
      for (var i = 0; i < strings.length; i++) {
        sizeEst += STR_ATTR_OVERHEAD_EST + strings[i].length;
      }
    }
    function sizifyBodyRep(rep) {
      sizeEst += LIST_OVERHEAD_EST +
                   NUM_OVERHEAD_EST * (rep.length / 2) +
                   STR_OVERHEAD_EST * (rep.length / 2);
      for (var i = 1; i < rep.length; i += 2) {
        if (rep[i])
          sizeEst += rep[i].length;
      }
    };
    function sizifyBodyReps(reps) {
      if (!reps)
        return;


      sizeEst += STR_OVERHEAD_EST * (reps.length / 2);
      for (var i = 0; i < reps.length; i++) {
        var rep = reps[i];
        if (rep.type === 'html') {
          sizeEst += STR_OVERHEAD_EST + rep.amountDownloaded;
        } else {
          rep.content && sizifyBodyRep(rep.content);
        }
      }
    };

    if (bodyInfo.to)
      sizifyAddrs(bodyInfo.to);
    if (bodyInfo.cc)
      sizifyAddrs(bodyInfo.cc);
    if (bodyInfo.bcc)
      sizifyAddrs(bodyInfo.bcc);
    if (bodyInfo.replyTo)
      sizifyStr(bodyInfo.replyTo);


    sizifyAttachments(bodyInfo.attachments);
    sizifyAttachments(bodyInfo.relatedParts);
    sizifyStringList(bodyInfo.references);
    sizifyBodyReps(bodyInfo.bodyReps);

    bodyInfo.size = sizeEst;

    this._insertIntoBlockUsingDateAndUID(
      'body', header.date, header.id, header.srvid, bodyInfo.size, bodyInfo,
      callback);
  },

  /**
   * Determines if the bodyReps of a given body have been downloaded...
   *
   * Note that for POP3 we will return false here if there are undownloaded
   * attachments even if the body parts are entirely downloaded.  This
   * situation would occur if the body is extremely small and so our snippet
   * fetch is able to fully retrieve the observed body parts.
   *
   *    storage.messageBodyRepsDownloaded(bodyInfo) => true/false
   *
   */
  messageBodyRepsDownloaded: function(bodyInfo) {
    // no reps its as close to downloaded as its going to get.
    if (!bodyInfo.bodyReps || !bodyInfo.bodyReps.length)
      return true;

    var bodyRepsDownloaded = bodyInfo.bodyReps.every(function(rep) {
      return rep.isDownloaded;
    });

    // As noted above, for POP3 we want to also validate the state of the
    // attachments since they need to be downloaded for the whole message to
    // have been downloaded.  Of course, we only want to do this for the inbox;
    // all other folders are synthetic and downloading is nonsensical.
    //
    // Sarcastic hooray for POP3 forcing us to do stuff like this.
    if (this._account.type !== 'pop3' || this.folderMeta.type !== 'inbox') {
      return bodyRepsDownloaded;
    }
    var attachmentsDownloaded = bodyInfo.attachments.every(function(att) {
      return !!att.file;
    });
    return bodyRepsDownloaded && attachmentsDownloaded;
  },

  /**
   * Identical to getMessageBody but will attempt to download all body reps
   * prior to firing its callback .
   */
  getMessageBodyWithReps: function(suid, date, callback) {
    var self = this;
    // try to get the body without any magic
    this.getMessageBody(suid, date, function(bodyInfo) {
      if (!bodyInfo) {
        return callback(bodyInfo);
      }
      if (self.messageBodyRepsDownloaded(bodyInfo)) {
        return callback(bodyInfo);
      }

      // queue a job and return bodyInfo after it completes..
      self._account.universe.downloadMessageBodyReps(suid, date,
                                                     function(err, bodyInfo) {
        // the err (if any) will be logged by the job.
        callback(bodyInfo);
      });
    });
  },

  /**
   * Load the given message body while obeying call ordering consistency rules.
   * If any other calls have gone asynchronous because block loads are required,
   * then this call will wait for those calls to complete first even if we
   * already have the requested body block loaded.  If we haven't gone async and
   * the body is already available, the callback will be invoked synchronously
   * while this function is still on the stack.  So, uh, don't be surprised by
   * that.
   */
  getMessageBody: function ifs_getMessageBody(suid, date, callback) {
    if (this._pendingLoads.length) {
      this._deferredCalls.push(
        this.getMessageBody.bind(this, suid, date, callback));
      return;
    }

    var id = parseInt(suid.substring(suid.lastIndexOf('.') + 1)),
        posInfo = this._findRangeObjIndexForDateAndID(this._bodyBlockInfos,
                                                      date, id);
    if (posInfo[1] === null) {
      this._LOG.bodyNotFound();
      try {
        callback(null);
      }
      catch (ex) {
        this._LOG.callbackErr(ex);
      }
      return;
    }
    var bodyBlockInfo = posInfo[1], self = this;
    if (!(this._bodyBlocks.hasOwnProperty(bodyBlockInfo.blockId))) {
      this._loadBlock('body', bodyBlockInfo, function(bodyBlock) {
          var bodyInfo = bodyBlock.bodies[id] || null;
          if (!bodyInfo)
            self._LOG.bodyNotFound();
          try {
            callback(bodyInfo);
          }
          catch (ex) {
            self._LOG.callbackErr(ex);
          }
        });
      return;
    }
    var block = this._bodyBlocks[bodyBlockInfo.blockId],
        bodyInfo = block.bodies[id] || null;
    if (!bodyInfo)
      this._LOG.bodyNotFound();
    try {
      callback(bodyInfo);
    }
    catch (ex) {
      this._LOG.callbackErr(ex);
    }
  },

  /**
   * Update a message body; this should only happen because of attachments /
   * related parts being downloaded or purged from the system.  This is an
   * asynchronous operation.
   *
   * Right now it is assumed/required that this body was retrieved via
   * getMessageBody while holding a mutex so that the body block must still
   * be around in memory.
   *
   * Additionally the final argument allows you to send an event to any client
   * listening for changes on a given body.
   *
   *    // client listening for a body change event
   *
   *    // ( body is a MessageBody )
   *    body.onchange = function(detail, bodyInfo) {
   *      // detail => { changeDetails: { bodyReps: [0], ... }, value: y }
   *    };
   *
   *    // in the backend
   *
   *    storage.updateMessageBody(
   *      header,
   *      changedBodyInfo,
   *      { changeDetails: { bodyReps: [0], ... }, value: y }
   *    );
   *
   * @method updateMessageBody
   * @param header {HeaderInfo}
   * @param bodyInfo {BodyInfo}
   * @param options {Object}
   * @param [options.flushBecause] {'blobs'}
   *   If present, indicates that we should flush the message body to disk and
   *   read it back from IndexedDB because we are writing Blobs that are not
   *   already known to IndexedDB and we want to replace potentially
   *   memory-backed Blobs with disk-backed Blobs.  This is essential for
   *   memory management.  There are currently no extenuating circumstances
   *   where you should lie to us about this.
   *
   *   This inherently causes saveAccountState to be invoked, so callers should
   *   sanity-check they aren't doing something weird to the database that could
   *   cause a non-coherent state to appear.
   *
   *   If you pass a value for this, you *must* forget your reference to the
   *   bodyInfo you pass in in order for our garbage collection to work!
   * @param eventDetails {Object}
   *   An event details object that describes the changes being made to the
   *   body representation.  This object will be directly reported to clients.
   *   If omitted, no event will be generated.  Only do this if you're doing
   *   something that should not be made visible to anything; like while the
   *   process of attaching
   *
   *   Please be sure to document everything here for now.
   * @param eventDetails.changeDetails {Object}
   *   An object indicating what changed in the body.  All of the following
   *   attributes are optional.  If they aren't present, the thing didn't
   *   change.
   * @param eventDetails.changeDetails.bodyReps {Number[]}
   *   The indices of the bodyReps array that changed.  In general bodyReps
   *   should only be added or modified.  However, in the case of POP3, a
   *   fictitious body part of type 'fake' may be created and may subsequently
   *   be removed.  No index is generated for the removal, but this should
   *   end up being okay because the UI should not reflect the 'fake' bodyRep
   *   into anything.
   * @param eventDetails.changeDetails.attachments {Number[]}
   *   The indices of the attachments array that changed by being added or
   *   modified.  Attachments may be detached; these indices are reported in
   *   detachedAttachments.
   * @param eventDetails.changeDetails.relatedParts {Number[]}
   *   The indices of the relatedParts array that changed by being added or
   *   modified.
   * @param eventDetails.changeDetails.detachedAttachments {Number[]}
   *   The indices of the attachments array that were deleted.  Note that this
   *   should only happen for drafts and no code should really be holding onto
   *   those bodies.  Additionally, the draft headers/bodies get nuked and
   *   re-created every time a draft is saved, so they shouldn't hang around in
   *   general.  However, we really do not want to allow the Blob references to
   *   leak, so we do report this so we can clean them up in clients.  splices
   *   for this case should be performed in the order reported.
   * @param callback {Function}
   *   A callback to be invoked after the body has been updated and after any
   *   body change notifications have been handed off to the MailUniverse.  The
   *   callback receives a reference to the updated BodyInfo object.
   */
  updateMessageBody: function(header, bodyInfo, options, eventDetails,
                              callback) {
    if (typeof(eventDetails) === 'function') {
      callback = eventDetails;
      eventDetails = null;
    }

    // (While this method can complete synchronously, we want to maintain its
    // perceived ordering relative to those that cannot be.)
    if (this._pendingLoads.length) {
      this._deferredCalls.push(this.updateMessageBody.bind(
                                 this, header, bodyInfo, options,
                                 eventDetails, callback));
      return;
    }

    var suid = header.suid;
    var id = parseInt(suid.substring(suid.lastIndexOf('.') + 1));
    var self = this;

    // (called when addMessageBody completes)
    function bodyUpdated() {
      if (options.flushBecause) {
        bodyInfo = null;
        self._account.saveAccountState(
          null, // no transaction to reuse
          function forgetAndReGetMessageBody() {
            // Force the block hosting the body to be discarded from the
            // cache.
            self.getMessageBody(suid, header.date, performNotifications);
          },
          'flushBody');
      }
      else {
        performNotifications();
      }
    }

    function performNotifications(refreshedBody) {
      if (refreshedBody) {
        bodyInfo = refreshedBody;
      }
      if (eventDetails && self._account.universe) {
        self._account.universe.__notifyModifiedBody(
          suid, eventDetails, bodyInfo
        );
      }

      if (callback) {
        callback(bodyInfo);
      }
    }

    // We always recompute the size currently for safety reasons, but as of
    // writing this, changes to attachments/relatedParts will not affect the
    // body size, only changes to body reps.
    this._deleteFromBlock('body', header.date, id, function() {
      self.addMessageBody(header, bodyInfo, bodyUpdated);
    });
  },

  shutdown: function() {
    // reverse iterate since they will remove themselves as we kill them
    for (var i = this._slices.length - 1; i >= 0; i--) {
      this._slices[i].die();
    }
    this.folderSyncer.shutdown();
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

var LOGFAB = exports.LOGFAB = $log.register(module, {
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
  FolderStorage: {
    type: $log.DATABASE,
    events: {
      addMessageHeader: { date: false, id: false, srvid: false },
      addMessageBody: { date: false, id: false, srvid: false },

      updateMessageHeader: { date: false, id: false, srvid: false },
      updateMessageBody: { date: false, id: false },

      generatePersistenceInfo: {},

      // For now, logging date and uid is useful because the general logging
      // level will show us if we are trying to redundantly delete things.
      // Also, date and uid are opaque identifiers with very little entropy
      // on their own.  (The danger is in correlation with known messages,
      // but that is likely to be useful in the debugging situations where logs
      // will be sufaced.)
      deleteFromBlock: { type: false, date: false, id: false },

      discardFromBlock: { type: false, date: false, id: false },

      // This was an error but the test results viewer UI is not quite smart
      // enough to understand the difference between expected errors and
      // unexpected errors, so this is getting downgraded for now.
      headerNotFound: {},
      bodyNotFound: {},

      syncedToDawnOfTime: {},
    },
    TEST_ONLY_events: {
      addMessageBody: { body: false },
      generatePersistenceInfo: { details: false }
    },
    asyncJobs: {
      loadBlock: { type: false, blockId: false },
      mutexedCall: { name: true },
    },
    TEST_ONLY_asyncJobs: {
      loadBlock: { block: false },
    },
    errors: {
      callbackErr: { ex: $log.EXCEPTION },

      badBlockLoad: { type: false, blockId: false },

      // Exposing date/uid at a general level is deemed okay because they are
      // opaque identifiers and the most likely failure models involve the
      // values being ridiculous (and therefore not legal).
      badIterationStart: { date: false, id: false },
      badDeletionRequest: { type: false, date: false, id: false },
      badDiscardRequest: { type: false, date: false, id: false },
      bodyBlockMissing: { id: false, idx: false, dict: false },
      serverIdMappingMissing: { srvid: false },

      accuracyRangeSuspect: { arange: false },

      mutexedOpErr: { err: $log.EXCEPTION },

      tooManyCallbacks: { name: false },
      mutexInvariantFail: { fireName: false, curName: false },
    }
  },
}); // end LOGFAB

}); // end define

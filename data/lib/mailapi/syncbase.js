define(
  [
    './date',
    'exports'
  ],
  function(
    $date,
    exports
  ) {

////////////////////////////////////////////////////////////////////////////////
// IMAP time constants

/**
 * How recently synchronized does a time range have to be for us to decide that
 * we don't need to refresh the contents of the time range when opening a slice?
 * If the last full synchronization is more than this many milliseconds old, we
 * will trigger a refresh, otherwise we will skip it.
 */
exports.OPEN_REFRESH_THRESH_MS = 10 * 60 * 1000;

/**
 * How recently synchronized does a time range have to be for us to decide that
 * we don't need to refresh the contents of the time range when growing a slice?
 * If the last full synchronization is more than this many milliseconds old, we
 * will trigger a refresh, otherwise we will skip it.
 */
exports.GROW_REFRESH_THRESH_MS = 60 * 60 * 1000;

////////////////////////////////////////////////////////////////////////////////
// Database Block constants
//
// Used to live in mailslice.js, but they got out of sync with the below which
// caused problems.

exports.EXPECTED_BLOCK_SIZE = 8;

/**
 * What is the maximum number of bytes a block should store before we split
 * it?
 */
exports.MAX_BLOCK_SIZE = exports.EXPECTED_BLOCK_SIZE * 1024,
/**
 * How many bytes should we target for the small part when splitting 1:2?
 */
exports.BLOCK_SPLIT_SMALL_PART = (exports.EXPECTED_BLOCK_SIZE / 3) * 1024,
/**
 * How many bytes should we target for equal parts when splitting 1:1?
 */
exports.BLOCK_SPLIT_EQUAL_PART = (exports.EXPECTED_BLOCK_SIZE / 2) * 1024,
/**
 * How many bytes should we target for the large part when splitting 1:2?
 */
exports.BLOCK_SPLIT_LARGE_PART = (exports.EXPECTED_BLOCK_SIZE / 1.5) * 1024;


////////////////////////////////////////////////////////////////////////////////
// Block Purging Constants (IMAP only)
//
// These values are all intended for resource-constrained mobile devices.  A
// more powerful tablet-class or desktop-class app would probably want to crank
// the values way up.

/**
 * Every time we create this many new body blocks, queue a purge job for the
 * folder.
 *
 * Body sizes are most variable and should usually take up more space than their
 * owning header blocks, so it makes sense for this to be the proxy we use for
 * disk space usage/growth.
 *
 * This used to be 4 when EXPECTED_BLOCK_SIZE was 96, it's now 8.  A naive
 * scaling would be by 12 to 48, but that doesn't handle that blocks can be
 * over the limit, so we want to aim a little lower, so 32.
 */
exports.BLOCK_PURGE_EVERY_N_NEW_BODY_BLOCKS = 32;

/**
 * How much time must have elapsed since the given messages were last
 * synchronized before purging?  Our accuracy ranges are updated whenever we are
 * online and we attempt to display messages.  So before we purge messages, we
 * make sure that the accuracy range covering the messages was updated at least
 * this long ago before deciding to purge.
 */
exports.BLOCK_PURGE_ONLY_AFTER_UNSYNCED_MS = 14 * $date.DAY_MILLIS;

/**
 * What is the absolute maximum number of blocks we will store per folder for
 * each block type?  If we have more blocks than this, we will discard them
 * regardless of any time considerations.
 *
 * The hypothetical upper bound for disk uage per folder is:
 * X 'number of blocks' * 2 'types of blocks' * 8k 'maximum block size'.  In
 * reality, blocks can be larger than their target if they have very large
 * bodies.
 *
 * This was 128 when our target size was 96k for a total of 24 megabytes.  Now
 * that our target size is 8k we're only scaling up by 8 instead of 12 because
 * of the potential for a large number of overage blocks.  This takes us to a
 * max of 1024 blocks.
 *
 * This is intended to protect people who have ridiculously high message
 * densities from time-based heuristics not discarding things fast enough.
 */
exports.BLOCK_PURGE_HARD_MAX_BLOCK_LIMIT = 1024;

////////////////////////////////////////////////////////////////////////////////
// General Sync Constants

/**
 * How frequently do we want to automatically synchronize our folder list?
 * Currently, we think that once a day is sufficient.  This is a lower bound,
 * we may sync less frequently than this.
 */
exports.SYNC_FOLDER_LIST_EVERY_MS = $date.DAY_MILLIS;

/**
 * How many messages should we send to the UI in the first go?
 */
exports.INITIAL_FILL_SIZE = 15;

/**
 * How many days in the past should we first look for messages.
 *
 * IMAP only.
 */
exports.INITIAL_SYNC_DAYS = 3;

/**
 * When growing our synchronization range, what should be the initial number of
 * days we should scan?
 */
exports.INITIAL_SYNC_GROWTH_DAYS = 3;

/**
 * What should be multiple the current number of sync days by when we perform
 * a sync and don't find any messages?  There are upper bounds in
 * `ImapFolderSyncer.onSyncCompleted` that cap this and there's more comments
 * there.  Note that we keep moving our window back as we go.
 *
 * This was 1.6 for a while, but it was proving to be a bit slow when the first
 * messages start a ways back.  Also, once we moved to just syncing headers
 * without bodies, the cost of fetching more than strictly required went way
 * down.
 *
 * IMAP only.
 */
exports.TIME_SCALE_FACTOR_ON_NO_MESSAGES = 2;

/**
 * What is the furthest back in time we are willing to go?  This is an
 * arbitrary choice to avoid our logic going crazy, not to punish people with
 * comprehensive mail collections.
 *
 * All of our sync range timestamps are quantized UTC days, so we are sure to
 * use an already UTC-quantized timestamp here.
 *
 * IMAP only.
 */
exports.OLDEST_SYNC_DATE = Date.UTC(1990, 0, 1);

/**
 * Don't bother with iterative deepening if a folder has less than this many
 * messages; just sync the whole thing.  The trade-offs here are:
 *
 * - Not wanting to fetch more messages than we need.
 * - Because header envelope fetches are done in a batch and IMAP servers like
 *   to sort UIDs from low-to-high, we will get the oldest messages first.
 *   This can be mitigated by having our sync logic use request windowing to
 *   offset this.
 * - The time required to fetch the headers versus the time required to
 *   perform deepening.  Because of network and disk I/O, deepening can take
 *   a very long time
 *
 * IMAP only.
 */
exports.SYNC_WHOLE_FOLDER_AT_N_MESSAGES = 40;

/**
 * If we issued a search for a date range and we are getting told about more
 * than the following number of messages, we will try and reduce the date
 * range proportionately (assuming a linear distribution) so that we sync
 * a smaller number of messages.  This will result in some wasted traffic
 * but better a small wasted amount (for UIDs) than a larger wasted amount
 * (to get the dates for all the messages.)
 *
 * IMAP only.
 */
exports.BISECT_DATE_AT_N_MESSAGES = 60;

/**
 * What's the maximum number of messages we should ever handle in a go and
 * where we should start failing by pretending like we haven't heard of the
 * excess messages?  This is a question of message time-density and not a
 * limitation on the number of messages in a folder.
 *
 * This could be eliminated by adjusting time ranges when we know the
 * density is high (from our block indices) or by re-issuing search results
 * when the server is telling us more than we can handle.
 *
 * IMAP only.
 */
exports.TOO_MANY_MESSAGES = 2000;


////////////////////////////////////////////////////////////////////////////////
// Size Estimate Constants

/**
 * The estimated size of a `HeaderInfo` structure.  We are using a constant
 * since there is not a lot of variability in what we are storing and this
 * is probably good enough.
 *
 * Our estimate is based on guesses based on presumed structured clone encoding
 * costs for each field using a reasonable upper bound for length.  Our
 * estimates are trying not to factor in compressability too much since our
 * block size targets are based on the uncompressed size.
 * - id: 4: integer less than 64k
 * - srvid: 40: 38 char uuid with {}'s, (these are uuid's on hotmail)
 * - suid: 13: 'xx/xx/xxxxx' (11)
 * - guid: 80: 66 character (unquoted) message-id from gmail, 48 from moco.
 *         This is unlikely to compress well and there could be more entropy
 *         out there, so guess high.
 * - author: 70: 32 for the e-mail address covers to 99%, another 32 for the
 *           display name which will usually be shorter than 32 but could
 *           involve encoded characters that bloat the utf8 persistence.
 * - date: 9: double that will be largely used)
 * - flags: 32: list which should normally top out at ['\Seen', '\Flagged'], but
 *              could end up with non-junk markers, etc. so plan for at least
 *              one extra.
 * - hasAttachments: 2: boolean
 * - subject: 80
 * - snippet: 100 (we target 100, it will come in under)
 */
exports.HEADER_EST_SIZE_IN_BYTES = 430;


////////////////////////////////////////////////////////////////////////////////
// Error / Retry Constants

/**
 * What is the maximum number of tries we should give an operation before
 * giving up on the operation as hopeless?  Note that in some suspicious
 * error cases, the try cont will be incremented by more than 1.
 *
 * This value is somewhat generous because we do assume that when we do
 * encounter a flakey connection, there is a high probability of the connection
 * being flakey in the short term.  The operations will not be excessively
 * penalized for this since IMAP connections have to do a lot of legwork to
 * establish the connection before we start the operation (CAPABILITY, LOGIN,
 * CAPABILITY).
 */
exports.MAX_OP_TRY_COUNT = 10;

/**
 * The value to increment the operation tryCount by if we receive an
 * unexpected error.
 */
exports.OP_UNKNOWN_ERROR_TRY_COUNT_INCREMENT = 5;

/**
 * If we need to defer an operation because the folder/resource was not
 * available, how long should we defer for?
 */
exports.DEFERRED_OP_DELAY_MS = 30 * 1000;

////////////////////////////////////////////////////////////////////////////////
// General defaults

/**
 * We use an enumerated set of sync values for UI localization reasons; time
 * is complex and we don't have/use a helper library for this.
 */
exports.CHECK_INTERVALS_ENUMS_TO_MS = {
  'manual': 0, // 0 disables; no infinite checking!
  '3min': 3 * 60 * 1000,
  '5min': 5 * 60 * 1000,
  '10min': 10 * 60 * 1000,
  '15min': 15 * 60 * 1000,
  '30min': 30 * 60 * 1000,
  '60min': 60 * 60 * 1000,
};

/**
 * Default to not automatically checking for e-mail for reasons to avoid
 * degrading the phone experience until we are more confident about our resource
 * usage, etc.
 */
exports.DEFAULT_CHECK_INTERVAL_ENUM = 'manual';

var DAY_MILLIS = 24 * 60 * 60 * 1000;

/**
 * Map the ActiveSync-limited list of sync ranges to milliseconds.  Do NOT
 * add additional values to this mapping unless you make sure that our UI
 * properly limits ActiveSync accounts to what the protocol supports.
 */
exports.SYNC_RANGE_ENUMS_TO_MS = {
  // This choice is being made for IMAP.
  'auto': 30 * DAY_MILLIS,
    '1d': 1 * DAY_MILLIS,
    '3d': 3 * DAY_MILLIS,
    '1w': 7 * DAY_MILLIS,
    '2w': 14 * DAY_MILLIS,
    '1m': 30 * DAY_MILLIS,
   'all': 30 * 365 * DAY_MILLIS,
};


////////////////////////////////////////////////////////////////////////////////
// Unit test support

/**
 * Testing support to adjust the value we use for the number of initial sync
 * days.  The tests are written with a value in mind (7), but 7 turns out to
 * be too high an initial value for actual use, but is fine for tests.
 *
 * This started by taking human-friendly strings, but I changed to just using
 * the constant names when I realized that consistency for grepping purposes
 * would be a good thing.
 */
exports.TEST_adjustSyncValues = function TEST_adjustSyncValues(syncValues) {
  if (syncValues.hasOwnProperty('fillSize'))
    exports.INITIAL_FILL_SIZE = syncValues.fillSize;
  if (syncValues.hasOwnProperty('days'))
    exports.INITIAL_SYNC_DAYS = syncValues.days;
  if (syncValues.hasOwnProperty('growDays'))
    exports.INITIAL_SYNC_GROWTH_DAYS = syncValues.growDays;

  if (syncValues.hasOwnProperty('SYNC_WHOLE_FOLDER_AT_N_MESSAGES'))
    exports.SYNC_WHOLE_FOLDER_AT_N_MESSAGES =
      syncValues.SYNC_WHOLE_FOLDER_AT_N_MESSAGES;
  if (syncValues.hasOwnProperty('bisectThresh'))
    exports.BISECT_DATE_AT_N_MESSAGES = syncValues.bisectThresh;
  if (syncValues.hasOwnProperty('tooMany'))
    exports.TOO_MANY_MESSAGES = syncValues.tooMany;

  if (syncValues.hasOwnProperty('scaleFactor'))
    exports.TIME_SCALE_FACTOR_ON_NO_MESSAGES = syncValues.scaleFactor;

  if (syncValues.hasOwnProperty('openRefreshThresh'))
    exports.OPEN_REFRESH_THRESH_MS = syncValues.openRefreshThresh;
  if (syncValues.hasOwnProperty('growRefreshThresh'))
    exports.GROW_REFRESH_THRESH_MS = syncValues.growRefreshThresh;

  if (syncValues.hasOwnProperty('HEADER_EST_SIZE_IN_BYTES'))
    exports.HEADER_EST_SIZE_IN_BYTES =
      syncValues.HEADER_EST_SIZE_IN_BYTES;

  if (syncValues.hasOwnProperty('BLOCK_PURGE_ONLY_AFTER_UNSYNCED_MS'))
    exports.BLOCK_PURGE_ONLY_AFTER_UNSYNCED_MS =
      syncValues.BLOCK_PURGE_ONLY_AFTER_UNSYNCED_MS;
  if (syncValues.hasOwnProperty('BLOCK_PURGE_HARD_MAX_BLOCK_LIMIT'))
    exports.BLOCK_PURGE_HARD_MAX_BLOCK_LIMIT =
      syncValues.BLOCK_PURGE_HARD_MAX_BLOCK_LIMIT;

  if (syncValues.hasOwnProperty('MAX_OP_TRY_COUNT'))
    exports.MAX_OP_TRY_COUNT = syncValues.MAX_OP_TRY_COUNT;
  if (syncValues.hasOwnProperty('OP_UNKNOWN_ERROR_TRY_COUNT_INCREMENT'))
    exports.OP_UNKNOWN_ERROR_TRY_COUNT_INCREMENT =
      syncValues.OP_UNKNOWN_ERROR_TRY_COUNT_INCREMENT;
};

}); // end define

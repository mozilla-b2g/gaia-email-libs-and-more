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
 * `REFRESH_USABLE_DATA_OLD_IS_SAFE_THRESH`.
 */
exports.REFRESH_USABLE_DATA_TIME_THRESH_NON_INBOX = 6 * $date.HOUR_MILLIS;
exports.REFRESH_USABLE_DATA_TIME_THRESH_INBOX = 2 * $date.HOUR_MILLIS;

/**
 * If the most recent message in a folder is older than this threshold, then
 * we assume it's some type of archival folder and so is unlikely to have any
 * meaningful churn so a refresh is optimal.  Also, the time range is
 * far enough back that our deepening strategy would result in unacceptable
 * latency.
 */
exports.REFRESH_USABLE_DATA_OLD_IS_SAFE_THRESH = 4 * 30 * $date.DAY_MILLIS;
exports.REFRESH_USABLE_DATA_TIME_THRESH_OLD = 2 * 30 * $date.DAY_MILLIS;

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
exports.USE_KNOWN_DATE_RANGE_TIME_THRESH_NON_INBOX = 7 * $date.DAY_MILLIS;
exports.USE_KNOWN_DATE_RANGE_TIME_THRESH_INBOX = 6 * $date.HOUR_MILLIS;

////////////////////////////////////////////////////////////////////////////////

/**
 * How many messages should we send to the UI in the first go?
 */
exports.INITIAL_FILL_SIZE = 15;

/**
 * How many days in the past should we first look for messages.
 */
exports.INITIAL_SYNC_DAYS = 3;

/**
 * What should be multiple the current number of sync days by when we perform
 * a sync and don't find any messages?  There are upper bounds in
 * `FolderStorage.onSyncCompleted` that cap this and there's more comments
 * there.
 */
exports.TIME_SCALE_FACTOR_ON_NO_MESSAGES = 1.6;

/**
 * What is the furthest back in time we are willing to go?  This is an
 * arbitrary choice to avoid our logic going crazy, not to punish people with
 * comprehensive mail collections.
 */
exports.OLDEST_SYNC_DATE = (new Date(1990, 0, 1)).valueOf();

/**
 * If we issued a search for a date range and we are getting told about more
 * than the following number of messages, we will try and reduce the date
 * range proportionately (assuming a linear distribution) so that we sync
 * a smaller number of messages.  This will result in some wasted traffic
 * but better a small wasted amount (for UIDs) than a larger wasted amount
 * (to get the dates for all the messages.)
 */
exports.BISECT_DATE_AT_N_MESSAGES = 50;

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
exports.TOO_MANY_MESSAGES = 2000;

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


////////////////////////////////////////////////////////////////////////////////
// Unit test support

/**
 * Testing support to adjust the value we use for the number of initial sync
 * days.  The tests are written with a value in mind (7), but 7 turns out to
 * be too high an initial value for actual use, but is fine for tests.
 */
exports.TEST_adjustSyncValues = function TEST_adjustSyncValues(syncValues) {
  exports.INITIAL_FILL_SIZE = syncValues.fillSize;
  exports.INITIAL_SYNC_DAYS = syncValues.days;

  exports.BISECT_DATE_AT_N_MESSAGES = syncValues.bisectThresh;
  exports.TOO_MANY_MESSAGES = syncValues.tooMany;

  exports.TIME_SCALE_FACTOR_ON_NO_MESSAGES = syncValues.scaleFactor;

  exports.REFRESH_USABLE_DATA_TIME_THRESH_NON_INBOX =
    syncValues.refreshNonInbox;
  exports.REFRESH_USABLE_DATA_TIME_THRESH_INBOX =
    syncValues.refreshInbox;
  exports.REFRESH_USABLE_DATA_OLD_IS_SAFE_THRESH =
    syncValues.oldIsSafeForRefresh;
  exports.REFRESH_USABLE_DATA_TIME_THRESH_OLD =
    syncValues.refreshOld;

  exports.USE_KNOWN_DATE_RANGE_TIME_THRESH_NON_INBOX =
    syncValues.useRangeNonInbox;
  exports.USE_KNOWN_DATE_RANGE_TIME_THRESH_INBOX =
    syncValues.useRangeInbox;

  if (syncValues.hasOwnProperty('MAX_OP_TRY_COUNT'))
    exports.MAX_OP_TRY_COUNT = syncValues.MAX_OP_TRY_COUNT;
  if (syncValues.hasOwnProperty('OP_UNKNOWN_ERROR_TRY_COUNT_INCREMENT'))
    exports.OP_UNKNOWN_ERROR_TRY_COUNT_INCREMENT =
      syncValues.OP_UNKNOWN_ERROR_TRY_COUNT_INCREMENT;
};

}); // end define

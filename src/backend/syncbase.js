import { DAY_MILLIS } from 'shared/date';

////////////////////////////////////////////////////////////////////////////////
// Autoconfig stuff

/**
 * The number of milliseconds to wait for various (non-ActiveSync) XHRs to
 * complete during the autoconfiguration process. This value is intentionally
 * fairly large so that we don't abort an XHR just because the network is
 * spotty.
 */
export let AUTOCONFIG_TIMEOUT_MS = 30 * 1000;

/**
 * The root of the ISPDB.  This must be HTTPS.  Okay to clobber for automated
 * tests, but should generally never be changed.
 */
export let ISPDB_AUTOCONFIG_ROOT =
  'https://live.mozillamessaging.com/autoconfig/v1.1/';

////////////////////////////////////////////////////////////////////////////////
// IMAP time constants


////////////////////////////////////////////////////////////////////////////////
// POP3 Sync Constants

/**
 * As we're syncing with POP3, pause every N messages to save state to disk.
 * This value was chosen somewhat arbitrarily.
 */
export let POP3_SAVE_STATE_EVERY_N_MESSAGES = 50;

/**
 * The maximum number of messages to retrieve during a single POP3
 * sync operation. If the number of unhandled messages left in the
 * spool exceeds this value, leftover messages will be filtered out of
 * this sync operation. They can later be downloaded through a
 * "download more messages..." option as per
 * <https://bugzil.la/939375>.
 *
 * This value (initially 100) is selected to be large enough that most
 * POP3 users won't exceed this many new messages in a given sync, but
 * small enough that we won't get completely overwhelmed that we have
 * to download this many headers.
 */
export let POP3_MAX_MESSAGES_PER_SYNC = 100;

/**
 * If a message is larger than INFER_ATTACHMENTS_SIZE bytes, guess
 * that it has an attachment.
 */
export let POP3_INFER_ATTACHMENTS_SIZE = 512 * 1024;

/**
 * Attempt to fetch this many bytes of messages during snippet fetching.
 */
export let POP3_SNIPPET_SIZE_GOAL = 4 * 1024; // in bytes

////////////////////////////////////////////////////////////////////////////////
// General Sync Constants

/**
 * How frequently do we want to automatically synchronize our folder list?
 * Currently, we think that once a day is sufficient.  This is a lower bound,
 * we may sync less frequently than this.
 *
 * TODO: This is dead, but we are probably a bit too overzealous with folder
 * list syncing now.
 */
export let SYNC_FOLDER_LIST_EVERY_MS = DAY_MILLIS;

/**
 * How many days in the past should we first look for messages.
 *
 * IMAP only.
 */
export let INITIAL_SYNC_DAYS = 3;

/**
 * When growing our synchronization range, what should be the initial number of
 * days we should scan?
 */
export let INITIAL_SYNC_GROWTH_DAYS = 3;

/**
 * When growing in a folder, what's the approximate number of messages we should
 * target to synchronize?  Note that this is in messages, not conversations.
 */
export let GROWTH_MESSAGE_COUNT_TARGET = 32;

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
export let OLDEST_SYNC_DATE = Date.UTC(1990, 0, 1);

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
export let SYNC_WHOLE_FOLDER_AT_N_MESSAGES = 40;

////////////////////////////////////////////////////////////////////////////////
// MIME Size / Parsing / Streaming Constants

/**
 * How many bytes-worth of typed array data should we accumulate before
 * condensing it into a Blob? Arbitrarily chosen.
 */
export let BYTES_PER_BLOB_CHUNK = 1024 * 1024;

/**
 * How many bytes should we request for each IMAP FETCH chunk request?
 * (Currently used only by attachment downloading, not body fetching).
 */
export let BYTES_PER_IMAP_FETCH_CHUNK_REQUEST = 1024 * 1024;

////////////////////////////////////////////////////////////////////////////////
// Download Stuff

/**
 * The device storage name to use when saving downloaded files.  It has always
 * been 'sdcard', it will probably always be 'sdcard'.  The choice of which
 * of internal/external storage is handled by DeviceStorage and the system
 * itself, not us.  You probably don't want to be changing this unless we change
 * on devices to store the other storage names in places that don't overlap with
 * 'sdcard'.  (As of this writing, on desktop the hacky/unsupported
 * devicestorage implementation does use disparate places unless in testing
 * mode.)
 */
export let DEVICE_STORAGE_NAME = 'sdcard';

////////////////////////////////////////////////////////////////////////////////
// General defaults

/**
 * We use an enumerated set of sync values for UI localization reasons; time
 * is complex and we don't have/use a helper library for this.
 */
export let CHECK_INTERVALS_ENUMS_TO_MS = {
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
export let DEFAULT_CHECK_INTERVAL_ENUM = 'manual';

/**
 * How many milliseconds should we wait before giving up on the
 * connection?
 *
 * This really wants to be adaptive based on the type of the
 * connection, but right now we have no accurate way of guessing how
 * good the connection is in terms of latency, overall internet
 * speed, etc. Experience has shown that 10 seconds is currently
 * insufficient on an unagi device on 2G on an AT&T network in
 * American suburbs, although some of that may be problems internal
 * to the device. I am tripling that to 30 seconds for now because
 * although it's horrible to drag out a failed connection to an
 * unresponsive server, it's far worse to fail to connect to a real
 * server on a bad network, etc.
 */
export let CONNECT_TIMEOUT_MS = 30000;

/**
 * When an IMAP connection has been left in the connection pool for
 * this amount of time, don't use that connection; spin up a fresh
 * connection instead. This value should be large enough that we don't
 * constantly spin up new connections, but short enough that we might
 * actually have connections open for that length of time.
 */
export let STALE_CONNECTION_TIMEOUT_MS = 30000;

/**
 * Kill any open IMAP connections if there are no jobs pending and there are no
 * slices open. This flag is mainly just for unit test sanity because 1) most
 * tests were written before this flag existed and 2) most tests don't care.
 * This gets disabled by default in testing; tests that care should turn this
 * back on.
 */
export let KILL_CONNECTIONS_WHEN_JOBLESS = true;

/**
 * Map the ActiveSync-limited list of sync ranges to milliseconds.  Do NOT
 * add additional values to this mapping unless you make sure that our UI
 * properly limits ActiveSync accounts to what the protocol supports.
 */
export let SYNC_RANGE_ENUMS_TO_MS = {
  // This choice is being made for IMAP.
  'auto': 30 * DAY_MILLIS,
    '1d': 1 * DAY_MILLIS,
    '3d': 3 * DAY_MILLIS,
    '1w': 7 * DAY_MILLIS,
    '2w': 14 * DAY_MILLIS,
    '1m': 30 * DAY_MILLIS,
   'all': 30 * 365 * DAY_MILLIS,
};

/**
 * What should our target be for snippet length?  In v1 this was 100, for v3
 * we want two lines worth, so we're bumping a little bit.  But this should
 * really just be parametrized by the consumer.
 */
export let DESIRED_SNIPPET_LENGTH = 160;

/**
 * These values were arbitrarily chosen during v1.0 development and haven't
 * posed a problem yet.  So, eh.
 */
export let DEFAULT_SEARCH_EXCERPT_SETTINGS = {
  charsBefore: 16,
  charsAfter: 40
};

/**
 * How big a chunk of an attachment should we encode in a single read?  Because
 * we want our base64-encoded lines to be 76 bytes long (before newlines) and
 * there's a 4/3 expansion factor, we want to read a multiple of 57 bytes.
 *
 * I initially chose the largest value just under 1MiB.  This appeared too
 * chunky on the ZTE open, so I'm halving to just under 512KiB.  Calculated via
 * Math.floor(512 * 1024 / 57) = 9198.  The encoded size of this ends up to be
 * 9198 * 78 which is ~700 KiB.  So together that's ~1.2 megs if we don't
 * generate a ton of garbage by creating a lot of intermediary strings.
 *
 * This seems reasonable given goals of not requiring the GC to run after every
 * block and not having us tie up the CPU too long during our encoding.
 */
export let BLOB_BASE64_BATCH_CONVERT_SIZE = 9198 * 57;

////////////////////////////////////////////////////////////////////////////////
// Cronsync/periodic sync stuff

/**
 * What is the longest allowable cronsync before we should infer that something
 * is badly broken and we should declare an epic failure that we report to the
 * front-end.
 *
 * While ideally this would be shorter than valid sync intervals
 */
export let CRONSYNC_MAX_DURATION_MS = 60 * 1000;

////////////////////////////////////////////////////////////////////////////////
// Unit test support

// TODO: Bring the test support mechanism back if it's needed.  exports should
// be live, but I think this might end up needing a big switch statement since
// it's not clear there's just a dictionary we can index.  (It might have made
// more sense to have just a single default export that's a dictionary and
// which the importers could destructure.  This could still happen.)
//
// Originally there was a method TEST_adjustSyncValues here which took a
// dictionary of values which it would potentially map from camelCase to
// DEFINE_CASE as we use above, clobbering our exported values.

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
 * folders.
 *
 * == How now unified folders?
 *
 * Unified folders are implemented by stitching together the contents of one
 * or more slices, fusing using the dates of the messages.
 */
function ImapSlice() {
}
ImapSlice.prototype = {
};


/**
 * Folder connections do the actual synchronization logic.  They are associated
 * with one or more `ImapSlice` instances that issue the requests that trigger
 * synchronization.  Storage is handled by `ImapFolderStorage` or
 * `GmailMessageStorage` instances.
 */
function ImapFolderConn() {
}
ImapFolderConn.prototype = {
};

/**
 * Per-folder message caching/storage named by their UID
 */
function ImapFolderStorage() {
}
ImapFolderStorage.prototype = {
};

/**
 * Like ImapFolderStorage, but with only one folder and messages named by their
 * X-GM-MSGID value rather than their UID(s).
 */
function GmailMessageStorage() {
}
GmailMessageStorage.prototype = {
};

}); // end define

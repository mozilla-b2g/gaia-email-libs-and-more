/**
 * @typedef {Object} FolderMeta
 * @property {FolderId} id
 *   ID assigned to the folder by the backend.  The first part of the name is
 *   the account this folder belongs to.
 * @property {String} [serverId]
 *   For ActiveSync folders, the server-issued id for the folder that we use to
 *   reference the folder.  This will be null for local-only folders.
 * @property {String} name
 *   The human-readable name of the folder with all utf-7 decoding/etc
 *   performed. This is intended to be shown to the user, the path should not
 *   be. Folder names should be considered private/personal data and if logged
 *   should be marked to be sanitized unless the user has explicitly enabled
 *   super-verbose privacy-entraining logs.
 * @property {String} type
 *   The type of the folder, i.e. 'inbox' or 'drafts'.
 *   Refer to mailapi.js for a list of acceptable values.
 * @property {String} path
 *   The fully qualified path of the folder.  For IMAP servers, this is the
 *   raw path including utf-7 encoded parts.  For ActiveSync and POP3 this is
 *   just for super-verbose private-data-entraining debugging and testing.
 *   This should be considered private/personal data like the folder name.
 * @property {String} [serverPath=null]
 *   The current path of the folder on the server, if the folder exists on the
 *   server.  This will be null if the folder is local-only.  When we eventually
 *   support folder renames, this may potentially be different from the `path`
 *   until we replay the move against the server.
 * @property {String} [delim]
 *   The delimiter to be used when constructing paths for child folders.
 * @property {number} depth
 *   The depth of the folder in the folder tree.  This is useful since the
 *   folders are stored as a flattened list, so attempts to display the folder
 *   hierarchy would otherwise have to compute this themselves.
 * @property {'folder'|'account'|'local-only'} syncGranularity
 *   Indicates the granularity at which this folder is synchronized with the
 *   server.  Some folders are not synchronized with a server, in which case
 *   the value 'local-only' is used.
 * @property {Boolean} fullySynced
 *   Is this folder fully synchronized?
 * @property {Number|null} localMessageCount
 *   The number of messages locally present in this folder.  This is tracked by
 *   a database trigger and so will be valid for local-only folders as well
 *   reflecting local changes that have not been applied to the server.  There
 *   is some overhead to maintaining this and it's not a given that it's worth
 *   whatever the overhead is.  However, it *is* useful for our gmail sync_grow
 *   implementation and should allow us to help vanilla IMAP generate internal
 *   consistency checks.
 * @property {Number|null} estimatedUnsyncedMessages
 *   The number of messages we think are not yet synchronized in this folder or
 *   null if we have no idea.
 * @property {DateMS|null} syncedThrough
 *   The oldest date we are synchronized through in this folder.  This will be
 *   null if we've never synchronized this folder or that's not how the sync
 *   engine for this account works.
 *
 * @property {DateMS} [lastSuccessfulSyncAt]
 *   The last time the folder was successfully synchronized, or 0 if the folder
 *   has never been (successfully) synchronized.  In the case of sync engines
 *   that operate on an account level or something like that (gmail), this will
 *   be updated as long as the account-level sync could find new messages in
 *   this folder.
 * @property {DateMS} [lastAttemptedSyncAt]
 *   Like lastSuccessfulSyncAt, but the last time we tried to synchronize the
 *   folder regardless of success.
 * @property {DateMS} [lastFailedSyncAt]
 *   Like lastSuccessfulSyncAt, but the last time we failed to synchronize the
 *   folder.  We do not zero this on success.
 * @property {Number} [failedSyncsSinceLastSuccessfulSync]
 *   The number of times we have failed to synchronize since the last time we
 *   successfully synchronized.  By definition, this is zeroed when a successful
 *   sync occurs.
 *
 * @property {Number} localUnreadConversations
 *   The number of locally-known unread conversations in this folder.
 */
export function makeFolderMeta(raw) {
  return {
    id: raw.id || null,
    serverId: raw.serverId || null,
    name: raw.name || null,
    type: raw.type || null,
    path: raw.path || null,
    serverPath: raw.serverPath || null,
    parentId: raw.parentId || null,
    delim: raw.delim || null,
    depth: raw.depth || 0,
    syncGranularity: raw.syncGranularity || null,
    localMessageCount: 0,
    estimatedUnsyncedMessages: null,
    syncedThrough: null,

    lastSuccessfulSyncAt: raw.lastSuccessfulSyncAt || 0,
    lastAttemptedSyncAt: raw.lastAttemptedSyncAt || 0,
    lastFailedSyncAt: raw.lastFailedSyncAt || 0,
    failedSyncsSinceLastSuccessfulSync:
      raw.failedSyncsSinceLastSuccessfulSync || 0,

    localUnreadConversations: raw.localUnreadConversations || 0,
  };
}

/**
 * Return true if the given folder type is local-only (i.e. we will
 * not try to sync this folder with the server).
 *
 * NOTE: The introduction of the "serverPath" property to the FolderMeta may
 * largely obviate the need for this.  (Specifically, it's null if there's no
 * corresponding online folder.)
 *
 * @param {String} type
 *   The type of the folderStorage, e.g. 'inbox' or 'localdrafts'.
 */
export function isTypeLocalOnly(type) {
  if (typeof type !== 'string') {
    throw new Error('isTypeLocalOnly() expects a string, not ' + type);
  }
  return (type === 'outbox' || type === 'localdrafts');
}

import evt from 'evt';

export default function MailFolder(api, wireRep, overlays, matchInfo) {
  evt.Emitter.call(this);
  this._api = api;

  this.__update(wireRep);
  this.__updateOverlays(overlays);
  this.matchInfo = matchInfo;
}
MailFolder.prototype = evt.mix({
  toString: function() {
    return '[MailFolder: ' + this.path + ']';
  },
  toJSON: function() {
    return {
      type: this.type,
      path: this.path
    };
  },
  /**
   * Loads the current unread message count as reported by the FolderStorage
   * backend. this.unread is the current number of unread messages that are
   * stored within the FolderStorage object for this folder. Thus, it only
   * accounts for messages which the user has loaded from the server.
   */
  __update: function(wireRep) {
    // Hold on to wireRep for caching
    this._wireRep = wireRep;

    this.localUnreadConversations = wireRep.localUnreadConversations;
    this.localMessageCount = wireRep.localMessageCount;

    let datify = (maybeDate) => (maybeDate ? new Date(maybeDate) : null);

    this.lastSuccessfulSyncAt = datify(wireRep.lastSuccessfulSyncAt);
    this.lastAttemptedSyncAt = datify(wireRep.lastAttemptedSyncAt);
    this.path = wireRep.path;
    this.id = wireRep.id;

    /**
     * The human-readable name of the folder.  (As opposed to its path or the
     * modified utf-7 encoded folder names.)
     */
    this.name = wireRep.name;
    /**
     * The full string of the path.
     */
    this.path = wireRep.path;
    /**
     * The hierarchical depth of this folder.
     */
    this.depth = wireRep.depth;
    /**
     * @oneof[
     *   @case['account']{
     *     It's not really a folder at all, just an account serving as hierarchy
     *   }
     *   @case['nomail']{
     *     A folder that exists only to provide hierarchy but which can't
     *     contain messages.  An artifact of various mail backends that are
     *     reflected in IMAP as NOSELECT.
     *   }
     *   @case['inbox']
     *   @case['drafts']
     *   @case['localdrafts']{
     *     Local-only folder that stores drafts composed on this device.
     *   }
     *   @case['sent']
     *   @case['trash']
     *   @case['archive']
     *   @case['junk']
     *   @case['starred']
     *   @case['important']
     *   @case['normal']{
     *     A traditional mail folder with nothing special about it.
     *   }
     * ]{
     *   Non-localized string indicating the type of folder this is, primarily
     *   for styling purposes.
     * }
     */
    this.type = wireRep.type;

    // Exchange folder name with the localized version if available
    this.name = this._api.l10n_folder_name(this.name, this.type);

    let hierarchyOnly = ((wireRep.type === 'account') ||
                         (wireRep.type === 'nomail'));
    this.selectable = !hierarchyOnly && !wireRep.engineSaysUnselectable;

    this.neededForHierarchy = hierarchyOnly;

    this.fullySynced = wireRep.fullySynced;

    /**
     *  isValidMoveTarget denotes whether this folder is a valid
     *  place for messages to be moved into.
     */
    switch (this.type) {
      case 'localdrafts':
      case 'outbox':
      case 'account':
      case 'nomail':
        this.isValidMoveTarget = false;
        break;
      default:
        this.isValidMoveTarget = true;
    }

    // -- Things mixed-in by the folders_toc from engine meta
    this.syncGranularity = wireRep.syncGranularity;
  },

  __updateOverlays: function(overlays) {
    let syncOverlay = overlays.sync_refresh || overlays.sync_grow || {};

    /**
     * Is a sync pending or actively being performed?  If truthy, one of these
     * things is happening.  Also check syncBlockedwhich indicates if the sync
     * is blocked by networking issues or account issues.
     *
     * Specific values syncStatus can take and their meanings:
     * - pending: A request has been issued but has yet to be processed.
     * - active: We are actively in the process of trying to do this thing.
     *   Once active, we should usually stay active, but in the event of
     *   connection loss we will return to the 'pending' state.
     *
     *
     * Eventually, sync_refresh will also provide syncBlocked which will be
     * one of: null/'offline/'bad-auth'/'unknown'.  This is per discussion
     * with :jrburke on IRC.
     */
    this.syncStatus = syncOverlay.status || null;

    /**
     * Is the sync blocked by something which prevents us from performing a
     * sync, this value will be truthy.
     *
     * Specific values and their meaning are:
     * - offline: Our device lacks usable network connectivity at this time.
     *   The operating system is likely to be example to express to the user
     *   that they are not connected to a network or need to take some further
     *   action like logging into a captive network portal.
     * - bad-auth: We think the user's credentials are incorrect and need to be
     *   updated.  More details will likely be provided on the MailAccount
     *   if we can provide them, but generally the idea is that the user is
     *   going to need to re-authenticate or take some other proactive action.
     *   Specifically:
     *   - If authenticating by password, the user may need to re-enter their
     *     password or the server may simply be suspicious of the user's login
     *     and some action needs to be taken via the web interface to make the
     *     server not suspicious.
     *   - If using oauth/similar, our auth tokens were likely revoked via
     *     some automatic or explicit process and the auth dance needs to be
     *     re-run.
     * - unknown: Something weird is wrong with the server/account that we don't
     *   understand.
     */
    this.syncBlocked = syncOverlay.blocked || null;
  },

  release: function() {
    // currently nothing to clean up
  }
});

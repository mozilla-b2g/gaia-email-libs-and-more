define(function(require) {
'use strict';

var evt = require('evt');

function MailFolder(api, wireRep, slice) {
  evt.Emitter.call(this);
  this._api = api;

  this.__update(wireRep);
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

    this.unread = wireRep.unreadCount;

    this.lastSyncedAt = wireRep.lastSyncedAt ? new Date(wireRep.lastSyncedAt)
                                             : null;
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

    this.selectable = ((wireRep.type !== 'account') &&
                       (wireRep.type !== 'nomail'));

    this.neededForHierarchy = !this.selectable;

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
  },

  release: function() {
    // currently nothing to clean up
  }
});

return MailFolder;
});

define(function(require, exports) {
'use strict';

/**
 * Account Mixins:
 *
 * This mixin function is executed from the constructor of the
 * CompositeAccount and ActiveSyncAccount, with 'this' being bound to
 * the main account instance. If the account has separate receive/send
 * parts, they are passed as arguments. (ActiveSync's receive and send
 * pieces merely reference the root account.)
 */
exports.accountConstructorMixin = function(receivePiece, sendPiece) {
  // The following flags are set on the receivePiece, because the
  // receiving side is what manages the job operations (and sending
  // messages from the outbox is a job).

  // On startup, we need to ignore any stale sendStatus information
  // from messages in the outbox. See `sendOutboxMessages` in
  // jobmixins.js.
  receivePiece.outboxNeedsFreshSync = true;
  // This is a runtime flag, used to temporarily prevent
  // `sendOutboxMessages` from executing, such as when the user is
  // actively trying to edit the list of messages in the Outbox.
  receivePiece.outboxSyncEnabled = true;
};

/**
 * Return the folder metadata for the first folder with the given type, or null
 * if no such folder exists.
 */
exports.getFirstFolderWithType = function(type) {
  var folders = this.folders;
  if (!folders) {
    try {
      throw new Error();
    }
    catch (ex) {
      console.log('getFirstFolderWithType explosion!', ex.stack);
      dump('EXPLOSION folders:\n' + ex.stack + '\n');
    }
  }
  for (var iFolder = 0; iFolder < folders.length; iFolder++) {
    if (folders[iFolder].type === type) {
      return folders[iFolder];
    }
  }
 return null;
};
exports.getFolderByPath = function(folderPath) {
  var folders = this.folders;
  for (var iFolder = 0; iFolder < folders.length; iFolder++) {
    if (folders[iFolder].path === folderPath) {
      return folders[iFolder];
    }
  }
  return null;
};
exports.getFolderById = function(id) {
  return this.foldersTOC.foldersById.get(id);
};

/**
 * Ensure that local-only folders live in a reasonable place in the
 * folder hierarchy by moving them if necessary.
 *
 * We proactively create local-only folders at the root level before
 * we synchronize with the server; if possible, we want these
 * folders to reside as siblings to other system-level folders on
 * the account. This is called at the end of syncFolderList, after
 * we have learned about all existing server folders.
 */
exports.normalizeFolderHierarchy = function() {
  // Find a folder for which we'd like to become a sibling.
  var sibling =
        this.getFirstFolderWithType('drafts') ||
        this.getFirstFolderWithType('sent');

  // If for some reason we can't find those folders yet, that's
  // okay, we will try this again after the next folder sync.
  if (!sibling) {
    return;
  }

  var parent = this.getFolderById(sibling.parentId);

  // NOTE: `parent` may be null if `sibling` is a top-level folder.
  var foldersToMove = [this.getFirstFolderWithType('localdrafts'),
                       this.getFirstFolderWithType('outbox')];

  foldersToMove.forEach(function(folder) {
    // These folders should always exist, but we double-check here
    // for safety. Also, if the folder is already in the right
    // place, we're done.
    if (!folder || folder.parentId === sibling.parentId) {
      return;
    }

    console.log('Moving folder', folder.name,
                'underneath', parent && parent.name || '(root)');


    this.universe.__notifyRemovedFolder(this, folder);

    // On `delim`: We previously attempted to discover a
    // server-specific root delimiter. ActiveSync hard-codes "/". POP3
    // doesn't even go that far. An empty delimiter would be
    // incorrect, as it could cause folder paths to smush into one
    // another. In the case where our folder doesn't specify a
    // delimiter, fall back to the standard-ish '/'.
    if (parent) {
      folder.path = parent.path + (parent.delim || '/') + folder.name;
      folder.delim = parent.delim || '/';
      folder.parentId = parent.id;
      folder.depth = parent.depth + 1;
    } else {
      folder.path = folder.name;
      folder.delim = '/';
      folder.parentId = null;
      folder.depth = 0;
    }

    this.universe.__notifyAddedFolder(this, folder);

  }, this);

};


}); // end define

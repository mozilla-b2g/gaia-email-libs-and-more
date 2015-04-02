define(function(require) {

let evt = require('evt');

let FOLDER_TYPE_TO_SORT_PRIORITY = {
  account: 'a',
  inbox: 'c',
  starred: 'e',
  important: 'f',
  drafts: 'g',
  localdrafts: 'h',
  outbox: 'i',
  queue: 'j',
  sent: 'k',
  junk: 'l',
  trash: 'n',
  archive: 'p',
  normal: 'z',
  // nomail folders are annoying since they are basically just hierarchy,
  //  but they are also rare and should only happen amongst normal folders.
  nomail: 'z',
};

function strcmp(a, b) {
  if (a < b)
    return -1;
  else if (a > b)
    return 1;
  return 0;
}

/**
 * Make a folder sorting function that groups folders by account, puts the
 * account header first in that group, maps priorities using
 * FOLDER_TYPE_TO_SORT_PRIORITY, then sorts by path within that.
 *
 * This is largely necessitated by localeCompare being at the mercy of glibc's
 * locale database and failure to fallback to unicode code points for
 * comparison purposes.
 */
function makeFolderSortString(account, folder) {
  if (!folder)
    return account.id;

  var parentFolder = account.getFolderMetaForFolderId(folder.parentId);
  return makeFolderSortString(account, parentFolder) + '!' +
         FOLDER_TYPE_TO_SORT_PRIORITY[folder.type] + '!' +
         folder.name.toLocaleLowerCase();
}


/**
 * Self-managed Folder TOC that owns the canonical list of folders for an
 * account.
 *
 * Each FoldersTOC is eternal.  You don't need to acquire or release it.
 *
 * Note: The back-end used to just order things by path.  And the front-end
 * ordered things by our crazy sort priority.  Now we use the sort priority here
 * in the back-end and expose that to the front-end too.
 */
function FoldersTOC(folderDbState) {
  evt.Emitter.call(this);

  this._folderDbState = folderDbState;

  this.meta = folderDbState.meta;

  /**
   * Canonical folder state representation.  This is what goes in the database.
   */
  this.foldersById = foldersDbState.folders;

  /**
   * Ordered list of the folders.
   */
  this.items = [];
  /**
   * Parallel ordering array to items; the contens are the folder sort strings
   * corresponding to the folder at the same index.
   *
   * While we could stick the sort string in the FolderInfo, the strings can
   * get long and ugly and we don't want to worry about changes to the sort
   * ordering screwing things up on upgrade/downgrade/etc.  Plus, this is how
   * we did it in v1.
   */
  this.folderSortStrings = [];


  for (let folderId in folder) {
    // ignore the $meta structure and now-moot $-prefixed hacks
    if (folderId[0] === '$')
      continue;
    let folderInfo = folderInfos[folderId];

    this.folders.push(folderInfo.$meta);
  }
}
FoldersTOC.prototype = evt.mix({
  addFolder: function(folderMeta) {
    let sortString = this.makeFolderSortString(folderMeta);
    let idx = bsearchForInsert(this.items, folderMeta, cmpFolderPubPath);
    this.items.splice(idx, 0, folderMeta);
    this.foldersTOC.emit('add', folderMeta, idx)

  },

  removeFolderById: function(id) {

  },

  generatePersistenceInfo: function() {

  },

});

return FoldersTOC;
});

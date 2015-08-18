define(function(require) {
'use strict';

let evt = require('evt');
let logic = require('logic');

let { bsearchForInsert } = require('../util');

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
  if (a < b) {
    return -1;
  } else if (a > b) {
    return 1;
  } else {
    return 0;
  }
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
function FoldersTOC(foldersDbState) {
  evt.Emitter.call(this);
  logic.defineScope(this, 'FoldersTOC');

  this._foldersDbState = foldersDbState;

  this.meta = foldersDbState.meta;

  /**
   * Canonical folder state representation.  This is what goes in the database.
   * @type {Map<FolderId, FolderInfo>}
   */
  this.foldersById = foldersDbState.folders;

  /**
   * Ordered list of the folders.
   */
  this.items = [];
  /**
   * Parallel ordering array to items; the contents are the folder sort strings
   * corresponding to the folder at the same index.
   *
   * While we could stick the sort string in the FolderInfo, the strings can
   * get long and ugly and we don't want to worry about changes to the sort
   * ordering screwing things up on upgrade/downgrade/etc.  Plus, this is how
   * we did it in v1.
   */
  this.folderSortStrings = [];


  for (let folderInfo of this.foldersById.values()) {
    this.addFolder(folderInfo);
  }
}
FoldersTOC.prototype = evt.mix({
  type: 'FoldersTOC',

  // We don't care about who references us because we have the lifetime of the
  // universe.  (At least, unless our owning account gets deleted.)
  __acquire: function() {
    return Promise.resolve(this);
  },

  __release: function() {
    // nothing to do
  },

  getAllItems: function() {
    return this.items;
  },

  /**
   * Make a folder sorting function that groups folders by account, puts the
   * account header first in that group, maps priorities using
   * FOLDER_TYPE_TO_SORT_PRIORITY, then sorts by path within that.
   *
   * This is largely necessitated by localeCompare being at the mercy of glibc's
   * locale database and failure to fallback to unicode code points for
   * comparison purposes.
   */
  _makeFolderSortString: function(folderInfo) {
    if (!folderInfo) {
      return '';
    }

    var parentFolderInfo = this.foldersById.get(folderInfo.parentId);
    return this._makeFolderSortString(parentFolderInfo) + '!' +
           FOLDER_TYPE_TO_SORT_PRIORITY[folderInfo.type] + '!' +
           folderInfo.name.toLocaleLowerCase();
  },

  addFolder: function(folderInfo) {
    let sortString = this._makeFolderSortString(folderInfo);
    let idx = bsearchForInsert(this.folderSortStrings, sortString, strcmp);
    this.items.splice(idx, 0, folderInfo);
    logic(this, 'addFolder',
          { id: folderInfo.id, index: idx, _folderInfo: folderInfo });
    this.folderSortStrings.splice(idx, 0, sortString);
    this.foldersById.set(folderInfo.id, folderInfo);

    this.emit('add', folderInfo, idx);
  },

  removeFolderById: function(id) {
    let folderInfo = this.foldersById.get(id);
    let idx = this.items.indexOf(folderInfo);
    logic(this, 'removeFolderById', { id: id, index: idx });
    if (!folderInfo || idx === -1) {
      throw new Error('the folder did not exist?');
    }
    this.foldersById.delete(id);
    this.items.splice(idx, 1);
    this.folderSortStrings.splice(idx, 1);
    this.emit('remove', id, idx);
  },

  /**
   * For cases like the sent folder or drafts folder where there is only one
   * true folder of this type, return that folder.  This supersedes our prior
   * use of getFirstFolderWithType whose semantics were less good.
   *
   * TODO: Actually have our logic not be the same as getFirstFolderWithType.
   */
  getCanonicalFolderByType: function(type) {
    return this.items.find(folder => folder.type === type);
  },

  generatePersistenceInfo: function() {
    return this._foldersDbState;
  },
});

return FoldersTOC;
});

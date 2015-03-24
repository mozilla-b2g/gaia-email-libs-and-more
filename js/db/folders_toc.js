define(function(require) {

var FOLDER_TYPE_TO_SORT_PRIORITY = {
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


function FoldersTOC() {

}
FoldersTOC.prototype = {

};

return FoldersTOC;
});

import { makeFolderMeta } from '../../db/folder_info_rep';

import { Enums as fhEnum } from 'activesync/codepages/FolderHierarchy';
var $FolderTypes = fhEnum.Type;


// Map folder type numbers from ActiveSync to GELAM's types
const folderTypes = {
   1: 'normal', // Generic
   2: 'inbox',  // DefaultInbox
   3: 'drafts', // DefaultDrafts
   4: 'trash',  // DefaultDeleted
   5: 'sent',   // DefaultSent
   6: 'normal', // DefaultOutbox
  12: 'normal', // Mail
};

/**
 * List of known junk folder names, taken from browserbox.js, and used to
 * infer folders that are junk folders based on their name since there is
 * no enumerated type representing junk folders.
 */
const junkFolderNames = [
  'bulk mail', 'correo no deseado', 'courrier indésirable', 'istenmeyen',
  'istenmeyen e-posta', 'junk', 'levélszemét', 'nevyžiadaná pošta',
  'nevyžádaná pošta', 'no deseado', 'posta indesiderata', 'pourriel',
  'roskaposti', 'skräppost', 'spam', 'spamowanie', 'søppelpost',
  'thư rác', 'спам', 'דואר זבל', 'الرسائل العشوائية', 'هرزنامه', 'สแปม',
  '垃圾郵件', '垃圾邮件', '垃圾電郵'
];


function getFirstFolderWithType(folderIdToFolderInfo, type) {
  for (let folderInfo of folderIdToFolderInfo.values()) {
    if (folderInfo.type === type) {
      return folderInfo;
    }
  }

  return null;
}

/**
 * Given a soup of ActiveSync folder arguments/meta-info, create a valid
 * FolderInfo structure.
 *
 * @param {string} serverId A GUID representing the new folder
 * @param {string} parentServerId A GUID representing the parent folder, or
 *  '0' if this is a root-level folder
 * @param {string} displayName The display name for the new folder
 * @param {string} typeNum A numeric value representing the new folder's type,
 *   corresponding to the mapping in _folderTypes above
 * @param {string} forceType Force a string folder type for this folder.
 *   Used for synthetic folders like localdrafts.
 * @param {boolean} suppressNotification (optional) if true, don't notify any
 *   listeners of this addition
 * @return {object} the folderMeta if we added the folder, true if we don't
 *   care about this kind of folder, or null if we need to wait until later
 *   (e.g. if we haven't added the folder's parent yet)
 */
export default function normalizeFolder(
  { idMaker, serverIdToFolderId, folderIdToFolderInfo },
  { serverId, parentServerId, displayName, typeNum, forceType }) {
  if (!forceType && !(typeNum in folderTypes)) {
    return true; // Not a folder type we care about.
  }

  let path = displayName;
  let parentFolderId = null;
  let depth = 0;
  if (parentServerId !== '0') {
    parentFolderId = serverIdToFolderId.get(parentServerId);
    let parentInfo = folderIdToFolderInfo.get(parentFolderId);
    // No parent yet?  Return null and the add will get deferred.
    if (!parent) {
      return null;
    }
    path = parentInfo.path + '/' + path;
    depth = parentInfo.depth + 1;
  }

  let useFolderType = folderTypes[typeNum];
  // Check if this looks like a junk folder based on its name/path.  (There
  // is no type for junk/spam folders, so this regrettably must be inferred
  // from the name.  At least for hotmail.com/outlook.com, it appears that
  // the name is "Junk" regardless of the locale in which the account is
  // created, but our current datapoint is one account created using the
  // Spanish locale.
  //
  // In order to avoid bad detections, we assume that the junk folder is
  // at the top-level or is only nested one level deep.
  if (depth < 2) {
    var normalizedName = displayName.toLowerCase();
    if (junkFolderNames.indexOf(normalizedName) !== -1) {
      useFolderType = 'junk';
    }
  }
  if (forceType) {
    useFolderType = forceType;
  }

  // Handle sentinel Inbox.
  if (typeNum === $FolderTypes.DefaultInbox) {
    let existingInboxMeta =
      getFirstFolderWithType(folderIdToFolderInfo, 'inbox');
    if (existingInboxMeta) {
      // Update everything about the folder meta.
      existingInboxMeta.serverId = serverId;
      existingInboxMeta.name = displayName;
      existingInboxMeta.path = path;
      existingInboxMeta.depth = depth;
      return true;
    }
  }

  var folderId = idMaker();
  var folderInfo = makeFolderMeta({
    id: folderId,
    serverId: serverId,
    name: displayName,
    type: useFolderType,
    path: path,
    parentId: parentFolderId,
    depth: depth,
    lastSyncedAt: 0
  });

  return folderInfo;
}

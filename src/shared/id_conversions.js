import { decodeA64Int } from 'shared/a64';

// From Identity Id's
export function accountIdFromIdentityId(identityId) {
  return identityId.split(/\./g, 1)[0];
}

// From Folder Id's
export function accountIdFromFolderId(folderId) {
  return folderId.split(/\./g, 1)[0];
}

/**
 * Return the JS Number that the folder-specific portion of the folder id
 * represents.  Specifically, we've got "<account portion>.<folder portion>",
 * and folder portion has been a64 encodeInt'ed.  We pick out that portion
 * and decode it back to a Number.
 */
export function decodeSpecificFolderIdFromFolderId(folderId) {
  let idxFirst = folderId.indexOf('.');
  return decodeA64Int(folderId.substring(idxFirst + 1));
}

// -- From Conversation Id's
// These look like: "accountId.gmailConvId"
export function accountIdFromConvId(convId) {
  return convId.split(/\./g, 1)[0];
}

export function encodedGmailConvIdFromConvId(convId) {
  let idxFirst = convId.indexOf('.');
  return convId.substring(idxFirst + 1);
}

export function convSpecificIdFromConvId(convId) {
  let idxFirst = convId.indexOf('.');
  return convId.substring(idxFirst + 1);
}

// -- From Message Id's
// These look like:
// "account.gmail conversation id.gmail message id.all mail folder uid"

/**
 * @return {AccountId}
 *   The string identifier for the account.
 */
export function accountIdFromMessageId(messageId) {
  return messageId.split(/\./g, 1)[0];
}

/**
 * @return {ConversationId}
 *   The sufficiently unique conversation id that is really
 *   "account id.encoded gmail conversation id".
 */
export function convIdFromMessageId(messageId) {
  let idxFirst = messageId.indexOf('.');
  let idxSecond = messageId.indexOf('.', idxFirst + 1);
  return messageId.substring(0, idxSecond);
}

export function encodedGmailConvIdFromMessageId(messageId) {
  return messageId.split(/\./g, 2)[1];
}

export function convSpecificIdFromMessageId(messageId) {
  return messageId.split(/\./g, 2)[1];
}

export function encodedGmailMessageIdFromMessageId(messageId) {
  return messageId.split(/\./g, 3)[2];
}

export function messageSpecificIdFromMessageId(messageId) {
  return messageId.split(/\./g, 3)[2];
}

export function stringUidFromMessageId(messageId) {
  return messageId.split(/\./g, 4)[3];
}

export function numericUidFromMessageId(messageId) {
  return parseInt(messageId.split(/\./g, 4)[3], 10);
}

// -- From Unique Message Id's
// These look like "account.folder.unique-for-folder"
/**
 * Take the "folder.unique-for-folder" bit and convert it into
 * "folder_unique-for-folder" so that dot delimiting works.  This value just
 * ends up needing to be unique, not reversible to underlying values.
 * (We likewise don't care about being able to go back to the umid, although
 * the predictable transform may be nice for debugging.)
 */
export function messageIdComponentFromUmid(umid) {
  let idxFirst = umid.indexOf('.');
  return umid.substring(idxFirst + 1).replace(/\./g, '_');
}


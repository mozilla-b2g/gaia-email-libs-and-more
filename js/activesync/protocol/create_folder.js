define(function(require) {
'use strict';

const $wbxml = require('wbxml');
const ASCP = require('activesync/codepages');

/**
 * Create a folder
 *
 * @param {ActiveSyncConnection} conn
 * @param {Object} args
 * @param {FolderSyncKey} args.folderSyncKey
 *   The sync key we use for FolderSync purposes on this account.  Note that
 *   this value should be replaced with the returned updated folderSyncKey.
 * @param {ActivesyncFolderServerId} args.parentFolderServerId
 * @param {String} args.folderName
 *
 * @return {{ serverId, folderSyncKey }}
 */
function* createFolder(conn, args) {
  const fh = ASCP.FolderHierarchy.Tags;
  const fhStatus = ASCP.FolderHierarchy.Enums.Status;
  const folderType = ASCP.FolderHierarchy.Enums.Type.Mail;

  let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
  w.stag(fh.FolderCreate)
     .tag(fh.SyncKey, args.folderSyncKey)
     .tag(fh.ParentId, args.parentFolderServerId)
     .tag(fh.DisplayName, args.folderName)
     .tag(fh.Type, folderType)
   .etag();

  let response = yield conn.postCommand(w);

  let e = new $wbxml.EventParser();
  let status, serverId, newFolderSyncKey;

  e.addEventListener([fh.FolderCreate, fh.Status], function(node) {
    status = node.children[0].textContent;
  });
  e.addEventListener([fh.FolderCreate, fh.SyncKey], function(node) {
    newFolderSyncKey = node.children[0].textContent;
  });
  e.addEventListener([fh.FolderCreate, fh.ServerId], function(node) {
    serverId = node.children[0].textContent;
  });

  try {
    e.run(response);
  }
  catch (ex) {
    console.error('Error parsing FolderCreate response:', ex, '\n',
                  ex.stack);
    throw 'unknown';
  }

  if (status === fhStatus.Success) {
    return { serverId, folderSyncKey: newFolderSyncKey };
  }
  else if (status === fhStatus.FolderExists) {
    throw 'already-exists';
  }
  else {
    throw 'unknown';
  }
}

return createFolder;
});

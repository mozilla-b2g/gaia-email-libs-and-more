import $wbxml from 'wbxml';
import $AirSync, { Tags as $as} from 'activesync/codepages/AirSync';
import { Tags as em } from 'activesync/codepages/Email';

/**
 * Modify one or messages in a folder by doing one or more of the following
 * things:
 * - Mark as read/unread
 * - Flag/unflag
 * - Delete the message
 * This notably does not include message moves.
 *
 * @param {ActiveSyncConnection} conn
 * @param {Object} args
 * @param {String} args.folderServerId
 * @param {Map<MessageServerId, BeRead>} args.read
 * @param {Map<MessageServerId, BeFlagged>} args.flag
 * @param {Set<MessageServerId>} args.delete
 * @param {Boolean} [permanentDeletion=false]
 *   Should deletions be irrevocable (versus moving to the trash folder)?
 */
export default async function modifyFolderMessages(conn, args) {
  let { folderServerId, folderSyncKey, permanentDeletion } =
    args;
  let readMap = args.read || new Map();
  let flagMap = args.flag || new Map();
  let deleteSet = args.delete || new Set();

  let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
  w.stag($as.Sync)
     .stag($as.Collections)
       .stag($as.Collection);

  if (conn.currentVersion.lt('12.1')) {
        w.tag($as.Class, 'Email');
  }

        w.tag($as.SyncKey, folderSyncKey)
         .tag($as.CollectionId, folderServerId)
         .tag($as.DeletesAsMoves, permanentDeletion ? '0' : 1)
         // GetChanges defaults to true, so we must explicitly disable it to
         // avoid hearing about changes.
         .tag($as.GetChanges, '0')
         .stag($as.Commands);

  for (let [serverId, beRead] of readMap) {
    w.stag($as.Change)
       .tag($as.ServerId, serverId)
       .stag($as.ApplicationData)
         .tag(em.Read, beRead ? '1' : '0')
       .etag($as.ApplicationData)
     .etag($as.Change);
  }
  for (let [serverId, beFlagged] of flagMap) {
    w.stag($as.Change)
       .tag($as.ServerId, serverId)
       .stag($as.ApplicationData)
         .stag(em.Flag)
           .tag(em.Status, beFlagged ? '2' : '0')
         .etag()
       .etag($as.ApplicationData)
     .etag($as.Change);
  }
  for (let serverId of deleteSet) {
    w.stag($as.Delete)
       .tag($as.ServerId, serverId)
     .etag($as.Delete);
  }

         w.etag($as.Commands)
       .etag($as.Collection)
     .etag($as.Collections)
   .etag($as.Sync);

  let response = await conn.postCommand(w);

  let e = new $wbxml.EventParser();
  let newSyncKey, status;

  let base = [$as.Sync, $as.Collections, $as.Collection];
  e.addEventListener(base.concat($as.SyncKey), function(node) {
    newSyncKey = node.children[0].textContent;
  });
  e.addEventListener(base.concat($as.Status), function(node) {
    status = node.children[0].textContent;
  });

  try {
    e.run(response);
  }
  catch (ex) {
    console.error('Error parsing Sync mutation response:', ex, '\n',
                  ex.stack);
    throw 'unknown';
  }

  if (status === $AirSync.Enums.Status.Success) {
    return { syncKey: newSyncKey };
  }
  else {
    console.error('Something went wrong during ActiveSync syncing and we ' +
                  'got a status of ' + status);
    throw 'unknown';
  }
}

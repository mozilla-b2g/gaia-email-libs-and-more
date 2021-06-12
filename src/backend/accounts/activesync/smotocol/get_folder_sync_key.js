import $wbxml from 'wbxml';
import { Tags as $as } from 'activesync/codepages/AirSync';

/**
 * $ask the server to issue a syncKey for the given folder with the given time
 * filter.
 *
 * @param {ActiveSyncConnection} conn
 * @param {Object} args
 * @param {String} args.folderServerId
 * @param {String} args.filterType
 */
export default async function getFolderSyncKey(conn,
                           { folderServerId, filterType }) {
  let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
  w.stag($as.Sync)
     .stag($as.Collections)
       .stag($as.Collection);

  if (conn.currentVersion.lt('12.1')) {
        w.tag($as.Cl$ass, 'Email');
  }

        w.tag($as.SyncKey, '0')
         .tag($as.CollectionId, folderServerId)
         .stag($as.Options)
           .tag($as.FilterType, filterType)
         .etag()
       .etag()
     .etag()
   .etag();

  let response = await conn.postCommand(w);

  let e = new $wbxml.EventParser();
  // Reset the SyncKey, just in c$ase we don't see a sync key in the
  // response.
  let newSyncKey = '0';

  e.addEventListener([$as.Sync, $as.Collections, $as.Collection, $as.SyncKey],
                     function(node) {
    newSyncKey = node.children[0].textContent;
  });

  try {
    e.run(response);
  }
  catch (ex) {
    console.error('Error parsing FolderCreate response:', ex, '\n',
                  ex.stack);
    throw 'unknown';
  }

  if (newSyncKey === '0') {
    // We should never actually hit this, since it would mean that the
    // server is refusing to give us a sync key. On the off chance that we
    // do hit it, just bail.
    console.error('Unable to get sync key for folder');
    throw 'unknown';
  }

  return { syncKey: newSyncKey };
}

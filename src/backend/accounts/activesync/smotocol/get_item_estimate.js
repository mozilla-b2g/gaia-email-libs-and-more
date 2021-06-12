import $wbxml from 'wbxml';
import { Tags as $as }from 'activesync/codepages/AirSync';
import { Tags as ie, Enums as ieEnum } from 'activesync/codepages/ItemEstimate';

/**
 * Get an estimate of the number of messages to be synced.
 * TODO: document how/why this needs both a syncKey and a filterType.  Very
 * confusing.  (Probably just the protocol being silly, but we should say that.)
 *
 * @param {ActiveSyncConnection} conn
 * @param {Object} args
 * @param {String} args.folderServerId
 * @param {String} args.folderSyncKey
 * @param {String} args.filterType
 */
export default async function getItemEstimate(
  conn, { folderSyncKey, folderServerId, filterType }) {
  let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
  w.stag(ie.GetItemEstimate)
     .stag(ie.Collections)
       .stag(ie.Collection);

  if (conn.currentVersion.gte('14.0')) {
        w.tag($as.SyncKey, folderSyncKey)
         .tag(ie.CollectionId, folderServerId)
         .stag($as.Options)
           .tag($as.FilterType, filterType)
         .etag();
  }
  else if (conn.currentVersion.gte('12.0')) {
        w.tag(ie.CollectionId, folderServerId)
         .tag($as.FilterType, filterType)
         .tag($as.SyncKey, folderSyncKey);
  }
  else {
        w.tag(ie.Class, 'Email')
         .tag($as.SyncKey, folderSyncKey)
         .tag(ie.CollectionId, folderServerId)
         .tag($as.FilterType, filterType);
  }

      w.etag(ie.Collection)
     .etag(ie.Collections)
   .etag(ie.GetItemEstimate);

  let response = await conn.postCommand(w);

  let e = new $wbxml.EventParser();
  let base = [ie.GetItemEstimate, ie.Response];

  let status, estimate;
  e.addEventListener(base.concat(ie.Status), function(node) {
    status = node.children[0].textContent;
  });
  e.addEventListener(base.concat(ie.Collection, ie.Estimate),
                     function(node) {
    estimate = parseInt(node.children[0].textContent, 10);
  });

  try {
    e.run(response);
  }
  catch (ex) {
    console.error('Error parsing FolderCreate response:', ex, '\n',
                  ex.stack);
    throw 'unknown';
  }

  if (status !== ieEnum.Status.Success) {
    throw 'unknown';
  }
  else {
    return { estimate };
  }
}

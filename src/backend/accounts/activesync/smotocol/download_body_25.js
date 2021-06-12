import $wbxml from 'wbxml';
import { Enums as ioEnum } from 'activesync/codepages/ItemOperations';
import { Tags as $as, Enums as asEnum } from 'activesync/codepages/AirSync';
import { Tags as em } from 'activesync/codepages/Email';

/**
 * Download a the entire message body for protocol 2.5 servers; there is no
 * truncation apparently.  Which sucks.
 * TODO: try and avoid always downloading the whole body, but we haven't gotten
 * around to it since day 1, and no one has really complained, so maybe this
 * isn't so bad?  (Also, maybe we have no way to do better.)
 *
 * @param {ActiveSyncConnection} conn
 * @param {Object} args
 * @param {Emitter} args.emitter
 *   The evt Emitter on which we fire add/change/remove events.
 *
 * @return {{ syncKey, bodyContent }}
 */
export default async function downloadBody(
  conn,
  { folderSyncKey, folderServerId, messageServerId, bodyType }) {
  let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
  w.stag($as.Sync)
     .stag($as.Collections)
       .stag($as.Collection)
         .tag($as.Class, 'Email')
         .tag($as.SyncKey, folderSyncKey) // XXX ugh, can we remove this?
         .tag($as.CollectionId, folderServerId)
         .stag($as.Options)
           .tag($as.MIMESupport, asEnum.MIMESupport.Never)
         .etag()
         .stag($as.Commands)
           .stag($as.Fetch)
             .tag($as.ServerId, messageServerId)
           .etag()
         .etag()
       .etag()
     .etag()
   .etag();

  let response = await conn.postCommand(w);

  let e = new $wbxml.EventParser();
  let base = [$as.Sync, $as.Collections, $as.Collection];
  let newSyncKey, status, bodyContent;

  e.addEventListener(base.concat($as.SyncKey), function(node) {
    newSyncKey = node.children[0].textContent;
  });
  e.addEventListener(base.concat($as.Status), function(node) {
    status = node.children[0].textContent;
  });
  e.addEventListener(base.concat($as.Responses, $as.Fetch,
                                 $as.ApplicationData, em.Body),
                     function(node) {
    bodyContent = node.children[0].textContent;
  });

  try {
    e.run(response);
  }
  catch (ex) {
    console.error('Error parsing FolderSync response:', ex, '\n',
                  ex.stack);
    throw 'unknown';
  }

  if (status !== ioEnum.Status.Success) {
    throw 'unknown';
  }

  return { syncKey: newSyncKey, bodyContent };
}

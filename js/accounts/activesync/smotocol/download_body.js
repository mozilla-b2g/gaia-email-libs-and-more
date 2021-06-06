import $wbxml from 'wbxml';
import { Tags as io, Enums as ioEnum } from
  'activesync/codepages/ItemOperations';
import { Tags as $as } from 'activesync/codepages/AirSync';
import { Tags as $asb } from 'activesync/codepages/AirSyncBase';

/**
 * Download a possibly truncated message body for 12.0 and higher servers.
 *
 * @param {ActiveSyncConnection} conn
 * @param {Object} args
 * @param {Type} [args.truncationSize]
 * @param {Emitter} args.emitter
 *   The evt Emitter on which we fire add/change/remove events.
 *
 * @return {{ invalidSyncKey, moreToSync }}
 */
export default async function downloadBody(
  conn, { folderServerId, messageServerId, bodyType, truncationSize }) {
  let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
  w.stag(io.ItemOperations)
     .stag(io.Fetch)
       .tag(io.Store, 'Mailbox')
       .tag($as.CollectionId, folderServerId)
       .tag($as.ServerId, messageServerId)
       .stag(io.Options)
         // Only get the AirSyncBase:Body element to minimize bandwidth.
         .stag(io.Schema)
           .tag($asb.Body)
         .etag()
         .stag($asb.BodyPreference)
           .tag($asb.Type, bodyType);

  if (truncationSize) {
          w.tag($asb.TruncationSize, truncationSize);
  }

        w.etag()
       .etag()
     .etag()
   .etag();

  let response = await conn.postCommand(w);

  let e = new $wbxml.EventParser();
  let status, bodyContent;
  e.addEventListener([io.ItemOperations, io.Status], function(node) {
    status = node.children[0].textContent;
  });
  e.addEventListener([io.ItemOperations, io.Response, io.Fetch,
                      io.Properties, $asb.Body, $asb.Data], function(node) {
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

  return { bodyContent };
}

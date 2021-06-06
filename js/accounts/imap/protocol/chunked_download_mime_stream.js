import mimefuncs from 'mimefuncs';
import { ReadableStream } from 'streams';

import MimeNodeTransformStream from '../../../streamy/mime_node_transform_stream';

/**
 * Creates a MimeNodeTransformStream fed by a producer stream that fetches
 * the attachment in (unstreamed) chunks via browserbox.
 *
 * @param {ParallelIMAP} arg.pimap
 * @param {FolderInfo} arg.folderInfo
 *   The folder the message is in.  Opaquely passed to `pimap`.
 * @param {ImapUid} arg.uid
 *   The UID of the message the part belongs to.  Opaquely passed to `pimap`.
 * @param {AttachmentInfo} arg.partInfo
 *   Describes the part to be downloaded.  We use the `part` to know what to
 *   download and `type` and `encoding` to interpret what we download.
 * @param {Number} arg.downloadChunkSize
 *   The size of the chunks we should request from the server.  We can't
 *   currently resume streaming, so this is all amount memory and latency
 *   tradeoffs.
 */
export default function chunkedDownloadMimeStream(
  { ctx, pimap, folderInfo, uid, partInfo, downloadChunkSize, saveChunkSize }) {
  let byteIndex = 0;

  let byteStream = new ReadableStream({
    start(out) {
      out.enqueue(
        mimefuncs.charset.encode(
          'Content-Type: ' + partInfo.type + '\r\n' +
          'Content-Transfer-Encoding: ' + partInfo.encoding + '\r\n' +
          '\r\n'));
    },
    pull(out) {
      return pimap.fetchBody(
        ctx,
        folderInfo,
        {
          uid,
          part: partInfo.part,
          byteRange: {
            offset: byteIndex,
            bytesToFetch: downloadChunkSize
          }
        })
      .then((chunk) => {
        out.enqueue(chunk);
        byteIndex += chunk.byteLength;
        // If we fetched less than the chunk size, then we got all the
        // data and we should make sure there is a terminating newline.
        if (chunk.length < downloadChunkSize) {
          out.enqueue(mimefuncs.charset.encode('\r\n'));
          out.close();
        }
      }, out.error);
    }
  });
  // Turn partInfo into a MimeNode stream with stream magic.
  return byteStream
    .pipeThrough(
      new MimeNodeTransformStream({ saveChunkSize, mimeType: partInfo.type }));
}


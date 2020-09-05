const { ReadableStream } = require('streams');

const chunkedDownloadMimeStream = require('./chunked_download_mime_stream');

/**
 * Given a message and a list of parts to fetch, this will produce a stream of
 * objects of the form { relId, blobCount, blob, done }.  See mix_download.js
 * for the exact semantics.
 *
 * Implementation-wise, we (with help from our helpers), for each part:
 * - Create a MimeNodeTransformStream.  It is fancy and intended to understand
 *   complex mime hiearchies, producing a stream of { partNum, headers,
 *   bodyStream } objects.  But we only feed it one part, the part we want.
 * - The bodyStream produces a stream of Blob instances, and it's these that
 *   we wrap with meta-info to output from our stream.  Note that the Blobs
 *   will have the mime type of the part annotated onto them already.  This
 *   is done for the cases where the entire part fits in a single chunk to avoid
 *   having to regenerate the Blob with the type.  However, you should keep in
 *   mind that this may be misleading/dangerous in the case where the part
 *   is split over multiple chunks.
 */
export default function messageChunkedPartStream({
    ctx, pimap, folderInfo, uid, parts, downloadChunkSize, saveChunkSize }) {
  // Pull the parts off as we go.
  let remainingPartsToFetch = parts.slice();

  // A pull stream, where each pull() corresponds to fetching a single part and
  // the generator will enqueue once for each blob and once to close out the
  // part.
  return new ReadableStream({
    start() {
    },

    async pull(out) {
      if (!remainingPartsToFetch.length) {
        out.close();
        return;
      }

      let blobIndex = 0;
      let partInfo = remainingPartsToFetch.shift();
      let mimeStream = chunkedDownloadMimeStream({
        ctx,
        pimap,
        folderInfo,
        uid,
        partInfo,
        downloadChunkSize,
        saveChunkSize
      });
      let mimeReader = mimeStream.getReader();

      // (We do not need the headers since it's information sourced from the
      // partInfo and already known to our caller.)
      let { value: { bodyStream } } = await mimeReader.read();
      let bodyReader = bodyStream.getReader();

      for (;;) {
        let { value: blob, done } = await bodyReader.read();
        if (!done) {
          out.enqueue({
            relId: partInfo.relId,
            blobCount: blobIndex++,
            blob,
            done
          });
        } else {
          out.enqueue({
            relId: partInfo.relId,
            blobCount: blobIndex,
            blob: null,
            done
          });
          break;
        }
      }

      bodyReader.cancel();
      mimeReader.cancel();
    }
  });
}

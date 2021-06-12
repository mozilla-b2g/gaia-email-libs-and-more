import streams from 'streams';
import util from 'util';

/**
 * ActiveSync allows us to download attachments in one of two ways: either
 * as base64-encoded-in-WBXML, or in binary as part of a "multipart" response.
 * Not to be confused with MIME multipart!
 *
 * This class transforms an ActiveSync multipart response into stream chunks of
 * { partIndex, partStream }.
 *
 * The request format is largely the same, with the addition of an extra
 * header ('MS-ASAcceptMultiPart'). The response format is described here:
 *
 * https://msdn.microsoft.com/en-us/library/jj663270%28v=exchg.80%29.aspx
 * https://msdn.microsoft.com/en-us/library/jj663353%28v=exchg.80%29.aspx
 */
export default function MultipartStream() {
  var self = this;
  var out;
  var offset = 0;
  var buffer = new Uint8Array(0);

  var partCount = null;
  var metadata = null;
  var currentPartIndex = 0;
  var currentPartLengthRemaining = 0;
  var currentPartStreamController = null;

  this.writable = new streams.WritableStream({
    start(error) {
      self.onerror = error;
    },
    write(chunk) {
      buffer = util.concatBuffers(buffer, chunk);

      while (buffer.byteLength > 0) {
        // First we need the part count.
        if (partCount === null) {
          if (buffer.byteLength < 4) {
            break; // Not enough data yet.
          }

          var dv = new DataView(buffer.buffer);
          partCount = dv.getUint32(dv, true);
          buffer = buffer.slice(4);
        }
        // Then we need the metadata for all the parts.
        else if (metadata === null) {
          var bytesNeededForMetadata = partCount * 8;
          if (buffer.byteLength < bytesNeededForMetadata) {
            break; // Not enough data yet.
          }

          metadata = new DataView(buffer.buffer.slice(0, bytesNeededForMetadata));
          buffer = buffer.slice(bytesNeededForMetadata);
        }
        // Now we can read parts.
        else {
          if (!currentPartStreamController) {
            currentPartLengthRemaining =
              metadata.getUint32(currentPartIndex * 8 + 4, true);

            out.enqueue({
              partIndex: currentPartIndex,
              partStream: new streams.ReadableStream({
                start(c) {
                  currentPartStreamController = c;
                }
              })
            });
          }

          var bytesToGrab = Math.min(currentPartLengthRemaining,
                                     buffer.byteLength);

          currentPartStreamController.enqueue(buffer.slice(0, bytesToGrab));
          currentPartLengthRemaining -= bytesToGrab;
          buffer = buffer.slice(bytesToGrab);
          console.log('grabbed', bytesToGrab, buffer.length);

          if (currentPartLengthRemaining === 0) {
            console.log('done with part');
            // We're done with this part.
            currentPartStreamController.close();
            currentPartStreamController = null;
            currentPartIndex++;
          }
        }
      }
    },
    close() {
      out.close();
    }
  });

  this.readable = new streams.ReadableStream({
    start(c) {
      out = c;
    },
    cancel() {

    }
  });
}

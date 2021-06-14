import messageChunkedPartStream from '../protocol/message_chunked_part_stream';

import { BYTES_PER_IMAP_FETCH_CHUNK_REQUEST, BYTES_PER_BLOB_CHUNK } from '../../../syncbase';

export default {
  async downloadParts(ctx, account, messageInfo, parts) {
    // - Get the folder and UID
    let { folderInfo, uid } =
      await this.getFolderAndUidForMesssage(ctx, account, messageInfo);

    // - Create and return the stream.
    return messageChunkedPartStream({
      ctx,
      pimap: account.pimap,
      folderInfo,
      uid,
      parts,
      downloadChunkSize: BYTES_PER_IMAP_FETCH_CHUNK_REQUEST,
      saveChunkSize: BYTES_PER_BLOB_CHUNK
    });
  },
};

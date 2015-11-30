define(function(require) {
'use strict';

const co = require('co');

const messageChunkedPartStream =
  require('../protocol/message_chunked_part_stream');

const syncbase = require('../../syncbase');

return {
  downloadParts: co.wrap(function*(ctx, account, messageInfo, parts) {
    // - Get the folder and UID
    let { folderInfo, uid } =
      yield this.getFolderAndUidForMesssage(ctx, account, messageInfo);

    // - Create and return the stream.
    return messageChunkedPartStream({
      ctx,
      pimap: account.pimap,
      folderInfo,
      uid,
      parts,
      downloadChunkSize: syncbase.BYTES_PER_IMAP_FETCH_CHUNK_REQUEST,
      saveChunkSize: syncbase.BYTES_PER_BLOB_CHUNK
    });
  }),
};
});

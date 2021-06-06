/**
 * Send a mail message for v12.x and lower ActiveSync servers.
 *
 * co-wrapped because outbox_send's sendMessage is expected to return a Promise.
 *
 * @param {ActiveSyncConnection} conn
 * @param {Object} args
 * @param {HTMLBlob} args.blob
 * @param {Function} args.progress
 *   A function to be invoked periodically on progress to help our caller know
 *   that we're still alive and doing things.
 */
export default async function sendMail(conn, { mimeBlob, progress }) {
  await conn.postData(
    'SendMail', 'message/rfc822', mimeBlob,
    {
      extraParams: {
        SaveInSent: 'T'
      },
      uploadProgress: progress,
    });
}

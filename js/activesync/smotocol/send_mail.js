define(function(require) {
'use strict';

const $wbxml = require('wbxml');
const { Tags: cm } = require('activesync/codepages/ComposeMail');

/**
 * Send a mail message for 14.0 and higher ActiveSync servers.
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
return function* sendMail(conn, { mimeBlob, progress }) {
  let w = new $wbxml.Writer('1.3', 1, 'UTF-8', null, 'blob');
  w.stag(cm.SendMail)
     // The ClientId is defined to be for duplicate messages suppression
     // and does not need to have any uniqueness constraints apart from
     // not being similar to (recently sent) messages by this client.
     .tag(cm.ClientId, Date.now().toString()+'@mozgaia')
     .tag(cm.SaveInSentItems)
     .stag(cm.Mime)
       .opaque(mimeBlob)
     .etag()
   .etag();

  let response = yield conn.postCommand(
    w,
    {
      uploadProgress: progress
    });

  if (response === null) {
    // - Success!
    // We can simply return.
    return;
  }

  // NB: we used to dump the response in this case, but we already have logging
  // hooks in place on the connection, and this could potentially include
  // private information that we do not want exposed.
  throw new Error('unknown');
};
});

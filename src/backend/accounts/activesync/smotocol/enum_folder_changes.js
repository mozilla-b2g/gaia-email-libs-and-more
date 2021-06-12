import logic from 'logic';

import $wbxml from 'wbxml';
import { Tags as $as, Enums as asEnum } from 'activesync/codepages/AirSync';

import parseFullMessage from './parse_full_message';
import parseChangedMessage from './parse_changed_message';

/**
 * High-level synchronization of the contents of a folder.  This routine
 * requires that a believed-valid syncKey and the filterType configured for that
 * syncKey are provided.  Results are provided by invoking the passed-in evt.js
 * Emitter with 'add', 'change', and 'remove' events as the WBXML stream is
 * parsed.  (Having us return a generator was considered but the control flow
 * gets potentially complex there, and as we move to streams for parsing, the
 * event emitter is arguably more aligned with that.)
 *
 * Note that it is possible the syncKey is no longer valid, in which case no
 * events will be emitted and our return value will have `invalidSyncKey` be
 * true.  That should be addressed and a new syncKey established before invoking
 * us again.
 *
 * NB: We used to have an empty request/response optimization.  In general this
 * has only brought us pain (device-id's were involved too.)  The optimization
 * has been ditched since it's not safe if we're doing multiple requests in
 * parallel without extensive coordination.
 *
 * @param {ActiveSyncConnection} conn
 * @param {Object} args
 * @param {String} args.folderServerId
 * @param {String} args.folderSyncKey
 * @param {String} args.filterType
 * @param {Function} args.issueIds
 *   Hacky hack that needs to return { messageId, umid, folderId } where the
 *   umid and derived messageId are freshly generated.  The rationale for
 *   doing this is to avoid that very-specific logic ending up in this file.
 * @param {Emitter} args.emitter
 *   The evt Emitter on which we fire add/change/remove events.
 *
 * @return {{ invalidSyncKey, syncKey, moreToSync }}
 */
export default async function enumerateFolderChanges(
  conn, { folderSyncKey, folderServerId, filterType, issueIds, emitter }) {
  let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
  w.stag($as.Sync)
     .stag($as.Collections)
       .stag($as.Collection);

  if (conn.currentVersion.lt('12.1')) {
        w.tag($as.Class, 'Email');
  }

        w.tag($as.SyncKey, folderSyncKey)
         .tag($as.CollectionId, folderServerId)
         .tag($as.GetChanges)
         .stag($as.Options)
           .tag($as.FilterType, filterType);

  // Older versions of ActiveSync give us the body by default. Ensure they
  // omit it.
  if (conn.currentVersion.lte('12.0')) {
          w.tag($as.MIMESupport, asEnum.MIMESupport.Never)
           .tag($as.Truncation, asEnum.MIMETruncation.TruncateAll);
  }

        w.etag()
       .etag()
     .etag()
   .etag();


  let response = await conn.postCommand(w);

  // Blank responses are the server's way of telling us nothing has changed.
  // So just fast-path out and leave the syncState the same.
  if (!response) {
    logic(conn, 'syncComplete', { emptyResponse: true });
    return {
      invalidSyncKey: false,
      syncKey: folderSyncKey,
      moreAvailable: false,
      noChanges: true
    };
  }

  let e = new $wbxml.EventParser();
  let base = [$as.Sync, $as.Collections, $as.Collection];

  let status;
  let newSyncKey;
  let moreAvailable = false;
  let addCount = 0, changeCount = 0, removeCount = 0;

  e.addEventListener(base.concat($as.SyncKey), function(node) {
    newSyncKey = node.children[0].textContent;
  });

  e.addEventListener(base.concat($as.Status), function(node) {
    status = node.children[0].textContent;
  });

  e.addEventListener(base.concat($as.MoreAvailable), function(node) {
    moreAvailable = true;
  });

  e.addEventListener(base.concat($as.Commands, $as.Add),
                     function(node) {
    let messageServerId, nodeToParse;

    for (let child of node.children) {
      switch (child.tag) {
        case $as.ServerId:
          messageServerId = child.children[0].textContent;
          break;
        case $as.ApplicationData:
          nodeToParse = child;
          break;
        default:
          break;
      }
    }

    if (nodeToParse && messageServerId) {
      try {
        let message = parseFullMessage(nodeToParse, issueIds());
        addCount++;
        emitter.emit('add', messageServerId, message);
      }
      catch (ex) {
        // If we get an error, just log it and skip this message.
        console.error('Failed to parse a full message:', ex, '\n', ex.stack);
        return;
      }
    }
  });

  e.addEventListener(base.concat($as.Commands, $as.Change),
                     function(node) {
    let messageServerId, changes;

    for (let child of node.children) {
      switch (child.tag) {
        case $as.ServerId:
          messageServerId = child.children[0].textContent;
          break;
        case $as.ApplicationData:
          try {
            changes = parseChangedMessage(child);
          }
          catch (ex) {
            // If we get an error, just log it and skip this message.
            console.error('Failed to parse a change:', ex, '\n', ex.stack);
            return;
          }
          break;
        default:
          break;
      }
    }

    if (messageServerId && changes) {
      changeCount++;
      emitter.emit('change', messageServerId, changes);
    }
  });


  e.addEventListener(base.concat($as.Commands, [[$as.Delete, $as.SoftDelete]]),
                     function(node) {
    let messageServerId;

    for (let child of node.children) {
      switch (child.tag) {
        case $as.ServerId:
          messageServerId = child.children[0].textContent;
          break;
        default:
          break;
      }
    }

    if (messageServerId) {
      removeCount++;
      emitter.emit('remove', messageServerId);
    }
  });

  try {
    e.run(response);
  }
  catch (ex) {
    console.error('Error parsing Sync response:', ex, '\n',
                  ex.stack);
    throw 'unknown';
  }

  if (status === asEnum.Status.Success) {
    logic(conn, 'syncComplete',
          { added: addCount, changed: changeCount, removed: removeCount });

    return { invalidSyncKey: false, syncKey: newSyncKey, moreAvailable };
  }
  else if (status === asEnum.Status.InvalidSyncKey) {
    return { invalidSyncKey: true, syncKey: '0', moreAvailable };
  }
  else {
    logic(conn, 'syncError', { status });
    throw 'unknown';
  }
}

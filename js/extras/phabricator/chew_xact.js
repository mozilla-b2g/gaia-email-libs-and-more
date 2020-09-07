import { millisecsToSeconds, secondsToMillisecs } from '../../date';

import mailRep from '../../db/mail_rep';

/**
 * Stateful processor of 'transaction.search' transactions, intended to be fed
 * transactions one-by-one via `chewTransaction`.  This ends up being the core
 * of the `sync_drev` task logic with the task basically being the network and
 * DB glue logic.
 *
 * This class is also taking on the responsibility that would normally be
 * handled by the conversation churning process.  Rationale:
 * - Because comments are now mutable, this means the previous read/unread
 *   ratchet isn't as simple as before.
 * - Phabricator has first-class conversation-level metadata that deserves first
 *   class processing.
 *   - Whatever is done here will likely want to be refactored to be somewhat
 *     modular and/or extensible, if only for being able to provide consistent
 *     cross-account xref logic.
 *
 * This class does not handle processing patch contents, that's the
 * `PatchChewer`.
 */
export class TransactionChewer {
  constructor({ userChewer, convId, oldConvInfo, oldMessages }) {
    this.userChewer = userChewer;
    this.convId = convId;
    this.oldConvInfo = oldConvInfo;

    this.oldMessages = oldMessages;
    // This is a mapping from the message id we synthesize.
    const oldById = this.oldById = new Map();
    for (const old of oldMessages) {
      oldById.set(old.id, old);
    }
  }

  chewTransaction(tx) {
    // As explained in `../sync.md` we pad a 0 onto the end for consistency
    // with email (gmail) message id's.
    const msgId = `${this.convId}.${tx.id}.0`;

    const msgInfo = mailRep.makeMessageInfo({
      id: msgId,
      umid: tx.phid,
      guid: null,
      // TODO: Figure out how to deal with `dateModified`...
      date: secondsToMillisecs(tx.dateCreated),
      author: this.userChewer.mapPhid(tx.authorPHID),
      // TODO: Convert nick name-checks to "to"?
      flags: [],
      // XXX/TODO: Is there any point to putting messages in folders versus just
      // leaving it at a conversation granularity?
      folderIds: new Set(),
      subject: '',

    });
  }
}
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
  constructor({ convId, oldConvInfo, oldMessages }) {
    this.convId = convId;
    this.oldConvInfo = oldConvInfo;

    this.oldMessages = oldMessages;
    const oldById = this.oldById = new Map();
    for (const old of oldMessages) {
      oldById.set();
    }
  }

  chewTransaction(tx) {
    // As explained in `../sync.md` we pad a 0 onto the end for consistency
    // with email (gmail) message id's.
    const msgId = `${this.convId}.${tx.id}.0`;

    const msgInfo = mailRep.makeMessageInfo({
      id: msgId,

    });
  }
}
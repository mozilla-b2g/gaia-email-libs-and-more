import { secondsToMillisecs } from 'shared/date';

import * as mailRep from '../../db/mail_rep';
import { processMessageContent, processAttributeContent } from '../../bodies/mailchew';

/**
 * Maps from the "type" of a transaction to information on how to process it.
 * Each handler object may have the following keys/values:
 * - deriveAttr(tx, userLookup): An optionally present function that takes the
 *   transaction and a userLookup method (bound from `UserChewer.mapPhid`)
 *   and returns an array of attribute dictionaries consistent with
 *   `processAttributeContent` or null.  If the function isn't present
 *   it's equivalent to providing a function that always returns null.
 * - notable(tx): An optionally present function that returns a boolean
 *   that is true if the changes in the transaction are worth bringing the
 *   user's attention to the revision on the basis of just this change.  For
 *   example, changes in subscribers are usually not notable, and a patch change
 *   that's just a rebase is probably also not notable (although not something
 *   directly exposed by phabricator.)  If absent, it's assumed the result would
 *   have been false.
 *
 * The goal of `deriveAttrs` is to:
 * - Produce a normalized representation for UI presentation of these attributes
 *   that's expressive enough for Phabricator's use cases but also likely to
 *   work (after some cleanup) with Bugzilla, GitHub and others.
 *   - Note that this is not intended to be presentation logic at this level.
 *     In particular, all string literals here are only intended to be used as
 *     keys to localization.
 *   - That said, a goal is that the results of this process should be roughly
 *     usable to English-reading developers and alpha testers without having
 *     created localizations or UI specializations.
 * - Perform fundamental lookups and name resolutions of users/projects.
 * - Be further consumable by summarizers/bundlers that can produce more compact
 *   visual presentations of data, as well as potentially eliding redundant/moot
 *   changes.
 *   - For example, the landing/backout process can be summarized.
 *   - And/or flags accidentally being changed and changed back can be
 *     summarized as such with the details collapsed.
 *   - The same change being made across multiple conversations can be picked
 *     out as a trend by a higher level display mechanism that can summarize the
 *     changes and then list what's impacted (loop hoisting style).
 */
const TRANSACTION_HANDLERS = new Map([
  /**
   * The null case is confusing and doesn't seem to actually get exposed in the
   * UI.  It usually seems to happen as part of a batch so it could be some
   * artifact of a multi-phase commit or something.
   */
  [
    null,
    {
    }
  ],
  /**
   * create: Seems to be the first transaction and be boring.
   */
  [
    'create',
    {
    }
  ],
  /**
   * title: string field with old/new, seems to be the second transaction and is
   * not boring.
   */
  [
    'title',
    {
      deriveAttrs(tx) {
        return [
          {
            name: 'title',
            type: 'string',
            old: tx.fields.old,
            new: tx.fields.new,
          },
        ];
      },
      notable() {
        return true;
      }
    }
  ],
  /**
   * summary: string field with old/new, This ends up being the commit message
   * plus an automated description of the patch stack depencies that looks like
   * `\n\nDepends on Dnnnn`.
   *
   * We ignore this for now because its content changes are boring and will
   * usually be accompanied by something that's notable.
   *
   * TODO: Explicitly handle stack changes as first-class elsewhere.
   */
  [
    'summary',
    {
      deriveAttrs(tx) {
        return [
          {
            name: 'summary',
            type: 'string',
            old: tx.fields.old,
            new: tx.fields.new,
          },
        ];
      },
      notable() {
        return true;
      }
    }
  ],
  /**
   * reviewers: complex list field, "fields" contains "operations".  PHIDs can
   * be USER or PROJ!  example:
   *
   *      {
            "operation": "add",
            "phid": "PHID-USER-nnnnnnn",
            "oldStatus": null,
            "newStatus": "blocking",
            "isBlocking": true
          }
   */
  [
    'reviewers',
    {
      deriveAttrs(tx, userLookup) {
        return tx.fields.operations.map((txOp) => {
          return {
            name: 'reviewers',
            type: 'set',
            setType: 'identity',
            op: txOp.operation,
            value: userLookup(txOp.phid),
            meta: [
              {
                key: 'blocking',
                value: txOp.isBlocking
              }
            ]
          };
        });
      },
      notable() {
        return true;
      }
    }
  ],
  /**
   * update: string field with old/new whose value is a PHID-DIFF.
   *
   * XXX This gets us the change marker, but the PHID isn't useful at all on its
   * own (nor should it be).
   * TODO: Implement patch analysis with this step here generating some level
   * of interdiff summary here.
   */
  [
    'update',
    {
      deriveAttrs(tx) {
        return [
          {
            // We are changing the name here because 'update' is generic and
            // confusing and we are going to be attaching additional semantics.
            name: 'patch-changed',
            type: 'string',
            old: tx.fields.old,
            new: tx.fields.new,
          },
        ];
      },
      notable() {
        return true;
      }
    }
  ],
  /**
   * projects: simple list field, "fields" contains "operations", example for
   * adding the "secure-revision" project and then removing it:
   *
   *      {
            "operation": "add",
            "phid": "PHID-PROJ-wkydohdk6pajyfn2llkb"
          }
          {
            "operation": "remove",
            "phid": "PHID-PROJ-wkydohdk6pajyfn2llkb"
          }
   */
  [
    'projects',
    {
      deriveAttrs(tx, userLookup) {
        return tx.fields.operations.map((txOp) => {
          return {
            name: 'projects',
            type: 'set',
            setType: 'identity',
            op: txOp.operation,
            value: userLookup(txOp.phid),
          };
        });
      },
      notable() {
        return true;
      }
    }
  ],
  /**
   * subscribers: simple list field like "projects"
   *
   * In my experience thus far changes to subscribers in the Mozilla setup are
   * reflecting changes to the CC list of security bugs or something like that
   * and not actually interesting on their own, so we're calling this not
   * notable.
   */
  [
    'subscribers',
    {
      deriveAttrs(tx, userLookup) {
        return tx.fields.operations.map((txOp) => {
          return {
            name: 'subscribers',
            type: 'set',
            setType: 'identity',
            op: txOp.operation,
            value: userLookup(txOp.phid),
          };
        });
      },
      notable() {
        return false;
      }
    }
  ],
  /**
   * status: string field that may be changed as part of a batch by other
   * explicit action types like 'request-review', 'request-changes', and
   * 'accept'.  This mapping is straightforward when there's a single reviewer,
   * but gets more complicated when there are multiple blocking reviewers.
   *
   * We don't need to understand any of that logic, though, as the "reviewers"
   * attachment on the DREV provides all the detail about the current state of
   * the review for each reviewer and the (top-level) "status" covers the
   * aggregate state.
   */
  [
    'status',
    {
      deriveAttrs(tx) {
        return [
          {
            name: 'status',
            type: 'string',
            old: tx.fields.old,
            new: tx.fields.new,
          },
        ];
      },
      notable() {
        return true;
      }
    }
  ],
  /**
   * request-review: weird global state change that should result in a "status"
   * transaction if this wasn't part of the initial creation batch.  The
   * "status" should have a "new" "fields" of "needs-review".
   */
  [
    'request-review',
    {
      deriveAttrs() {
        return [
          {
            name: 'request-review',
            type: 'action',
          },
        ];
      },
      notable() {
        return true;
      }
    }
  ],
  /**
   * request-changes: weird global state change that should result in a "status"
   * transaction that should have a "new" "fields" of "needs-revision".
   */
  [
    'request-changes',
    {
      deriveAttrs() {
        return [
          {
            name: 'request-changes',
            type: 'action',
          },
        ];
      },
      notable() {
        return true;
      }
    }
  ],
  /**
   * accept: weird global state change that should result in a "status"
   * transaction that should have a "new" "fields" of "accepted".
   */
  [
    'accept',
    {
      deriveAttrs() {
        return [
          {
            name: 'accept',
            type: 'action',
          },
        ];
      },
      notable() {
        return true;
      }
    }
  ],
  /**
   * close: no "status" expected, may have a "CommitPHIDs" "fields" that is just
   * an array of PHIDs.
   *
   * For now we don't expose the CommitPHIDs but it likely makes sense to do so,
   * and it could be neat if these included info from the mercurial server like
   * what release / nightly the changes went into, etc.
   */
  [
    'close',
    {
      deriveAttrs() {
        return [
          {
            name: 'close',
            type: 'action',
          },
        ];
      },
      notable() {
        return true;
      }
    }
  ],
]);

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
  constructor({ taskContext, userChewer, convId, oldConvInfo, oldMessages, foldersTOC, revInfo }) {
    this.taskCtx = taskContext;
    this.userChewer = userChewer;
    this.userLookup = userChewer.mapPhid.bind(userChewer);
    this.convId = convId;
    this.oldConvInfo = oldConvInfo;
    this.oldMessages = oldMessages;
    this.foldersTOC = foldersTOC;
    this.revInfo = revInfo;

    this.inboxFolder = foldersTOC.getCanonicalFolderByType('inbox');

    // This is a mapping from the message id we synthesize.
    const oldById = this.oldById = new Map();
    for (const old of oldMessages) {
      oldById.set(old.id, old);
    }

    this.modifiedMessageMap = new Map();
    this.newMessages = [];
    this.allMessages = [];

    /**
     * Tracks whether any transactions have been encountered that are notable
     * and should result in the conversation marked as having new changes that
     * haven't been seen.
     */
    this.notableChanges = 0;
  }

  chewTransaction(tx) {
    // As explained in `../sync.md` we pad a 0 onto the end for consistency
    // with email (gmail) message id's.
    const msgId = `${this.convId}.${tx.id}.0`;

    const folderIds = new Set([this.inboxFolder.id]);

    // If we've previously seen this message and it hasn't been modified, then
    // skip processing it.
    //
    // TODO: Consider whether it makes sense to only sparsely convert the
    // transactions and/or aggregate them based on time.  The transaction log
    // is much more granular than the high level actions that generate them,
    // and it seems wasteful and counterproductive to have this exact mapping.
    // But for initial implementation the simplicity IS desirable.
    if (this.oldById.has(msgId)) {
      const oldMsg = this.oldById.get(msgId);
      if (oldMsg.dateModified === secondsToMillisecs(tx.dateModified)) {
        this.allMessages.push(oldMsg);
        return;
      }
      // This means that the contents of the message did change.  For simplicity
      // we'll just create a new version of the message and put it in the
      // modified message map.
      //
      // TODO: There might be some object identity issues with doing this?  Thus
      // far we've always mutated in place but I forget the rules on this... but
      // I also think if this is technically incorrect, it's probably also fine,
      // so...
    }

    let contentBlob, snippet, authoredBodySize;
    let bodyReps = [];
    // This covers type=inline (code line comment) and type=comment (general
    // comment).
    if (tx.comments && tx.comments.length) {
      // Comments are notable!
      this.notableChanges++;

      const commentText = tx.comments[0].content.raw;
      ({ contentBlob, snippet, authoredBodySize } = processMessageContent(
        commentText,
        'plain',
        true, // isDownloaded
        true // generateSnippet
      ));

      bodyReps.push(mailRep.makeBodyPart({
        type: 'plain',
        part: null,
        sizeEstimate: commentText.length,
        amountDownloaded: commentText.length,
        isDownloaded: true,
        _partInfo: null,
        contentBlob,
        authoredBodySize,
      }));
    } else {
      const handler = TRANSACTION_HANDLERS.get(tx.type);
      if (handler) {
        if (handler.notable && handler.notable(tx)) {
          this.notableChanges++;
        }

        if (handler.deriveAttrs) {
          const attrs = handler.deriveAttrs(tx, this.userLookup);
          if (attrs) {
            ({ contentBlob, snippet, authoredBodySize } =
              processAttributeContent(attrs));
            bodyReps.push(mailRep.makeBodyPart({
              type: 'attr',
              part: null,
              sizeEstimate: contentBlob.size,
              amountDownloaded: contentBlob.size,
              isDownloaded: true,
              _partInfo: null,
              contentBlob,
              authoredBodySize,
            }));
          }
        }
      }
    }

    const msgInfo = mailRep.makeMessageInfo({
      id: msgId,
      umid: tx.phid,
      guid: null,
      date: secondsToMillisecs(tx.dateCreated),
      dateModified: secondsToMillisecs(tx.dateModified),
      author: this.userChewer.mapPhid(tx.authorPHID),
      // TODO: Convert nick name-checks to "to"?
      flags: [],
      folderIds,
      // XXX Currently we only need this on the first message per the churn
      // logic, but that fails to update with changes to the title, so more work
      // is necessary, etc.
      subject: this.revInfo.fields.title,
      snippet,
      attachments: [],
      relatedParts: null,
      references: null,
      bodyReps,
      authoredBodySize,
      draftInfo: null,
    });

    this.allMessages.push(msgInfo);
    if (this.oldById.has(msgId)) {
      this.modifiedMessageMap.set(msgId, msgInfo);
    } else {
      this.newMessages.push(msgInfo);
    }
  }
}

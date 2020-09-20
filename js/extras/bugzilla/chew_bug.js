import * as mailRep from '../../db/mail_rep';
import { processMessageContent, processAttributeContent } from '../../bodies/mailchew';

/**
 * Merges bug comments and history back together into a unified representation
 * that becomes our basis for a single ordered set of messages, then processes
 * those into messages.
 *
 * Because of the need to first create a unified representation, much of the
 * work of sync_bug is pushed into the processBug method.  (Compare with
 * the Phabricator sync_drev task which drives the transaction consumption
 * because there's only the single transaction stream of data for both comments
 * and metadata.)
 */
export class BugChewer {
  constructor({ userChewer, convId, oldConvInfo, oldMessages, foldersTOC, bugInfo }) {
    this.userChewer = userChewer;
    this.convId = convId;
    this.oldConvInfo = oldConvInfo;
    this.oldMessages = oldMessages;
    this.foldersTOC = foldersTOC;
    this.bugInfo = bugInfo;

    this.inboxFolder = foldersTOC.getCanonicalFolderByType('inbox');

    // This is a mapping from the message id we synthesize.
    const oldById = this.oldById = new Map();
    for (const old of oldMessages) {
      oldById.set(old.id, old);
    }

    this.unifiedEvents = [];

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

  _mergeHistoryAndComments() {
    const bugInfo = this.bugInfo;
    const unified = this.unifiedEvents;

    let iHistory = 0;
    let iComment = 0;

    while (iHistory < bugInfo.history.length ||
           iComment < bugInfo.comments.length) {
      // We currently leverage these ending up undefined past the end.
      const nextHistory = bugInfo.history[iHistory];
      const nextComment = bugInfo.comments[iComment];

      if (!nextHistory) {
        // There's no next history, so push the comment.
        unified.push({ history: null, comment: nextComment });
        iComment++;
        continue;
      } else if (!nextComment) {
        // There's no next comment, so push the history.
        unified.push({ history: nextHistory, comment: null });
        iHistory++;
        continue;
      } else if (nextHistory.when === nextComment.creation_time &&
                 nextHistory.who === nextComment.author) {
        // ## They're the same event, unify!
        unified.push({
          history: nextHistory,
          comment: nextComment,
        });
        iHistory++;
        iComment++;
        continue;
      }

      // There must be a nextHistory and a nextComment but they're not the same
      // event, so one must come before the other.  (Noting that it's possible
      // for there to be an ambiguous hypothetical case where they do share the
      // same timestamp but not the same author.  And in that situation there
      // might actually be a matching pair that's offset by the single history
      // or comment that shares the same timestamp.  Or maybe it's not.  But
      // that would want a lookahead, which seems easy to screw up, and it's not
      // clear it's either theoretically or practically possible to successfully
      // collide on timestamp given the bugzilla UX on midair collisions.
      const histDate = new Date(nextHistory.when);
      const commentDate = new Date(nextComment.creation_time);
      if (histDate < commentDate) {
        unified.push({ history: nextHistory, comment: null});
        iHistory++;
        continue;
      } else {
        unified.push({ history: null, comment: nextComment });
        iComment++;
        continue;
      }
      // control flow can't reach here.
    }
  }

  chewBug() {
    this._mergeHistoryAndComments();

    let iEvent = 0;
    for (const eventInfo of this.unifiedEvents) {
      this._chewEvent(iEvent++, eventInfo);
    }
  }

  _chewEvent(iEvent, { history, comment }) {
    // Padded for consistency with email (gmail) message id's.
    const msgId = `${this.convId}.${iEvent}.0`;

    // If we've previously seen this event and it doesn't seem like it's changed
    // due to the comment being edited, then don't do anything.
    if (this.oldById.has(msgId)) {
      const oldMsg = this.oldById.get(msgId);
      // XXX uh, for now, see if the length of the body changed.  This is...
      // pretty dumb, but fetching the body isn't free and I don't really want
      // to both with using crypto.subtle for this yet, plus there may actually
      // be some way to get the REST API to tell us when comments have been
      // edited.
      const plainBody = oldMsg.bodyReps.find((rep) => rep.type === 'plain');
      // If there's no comment or we didn't have a plain body part, or the size
      // of that plain part is the same as the size of the currently reported
      // comment, then there's no need to re-process.
      if (!comment || !plainBody ||
           plainBody.authoredBodySize === comment.raw_text.length) {
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
    if (history) {
      // XXX for now, assume all attribute changes are notable, but this wants
      // a lookup table like Phabricator.
      this.notableChanges++;
      const attrs = history.changes.map((change) => {
        return {
          name: change.field_name,
          type: 'string',
          // there's a semantic mismatch here, but we can fix that when we
          // improve the attribute reps.
          old: change.removed,
          new: change.added,
        };
      });
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
    if (comment && comment.raw_text) {
      // Comments are notable!
      this.notableChanges++;

      const commentText = comment.raw_text;
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
    }

    const authorLogin = comment ? comment.creator : history.who;
    const date = new Date(comment ? comment.creation_time : history.when);

    const msgInfo = mailRep.makeMessageInfo({
      id: msgId,
      umid: comment ? comment.id : null,
      guid: null,
      date: date.valueOf(),
      dateModified: date.valueOf(),
      author: this.userChewer.mapLogin(authorLogin),
      // TODO: Convert nick name-checks to "to"?
      flags: [],
      // XXX/TODO: Is there any point to putting messages in folders versus just
      // leaving it at a conversation granularity?
      folderIds: new Set([this.inboxFolder.id]),
      // XXX Currently we only need this on the first message per the churn
      // logic, but that fails to update with changes to the title, so more work
      // is necessary, etc.
      subject: this.bugInfo.summary,
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
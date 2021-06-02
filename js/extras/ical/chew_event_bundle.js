import ICAL from 'ical.js';

import * as mailRep from '../../db/mail_rep';
import { processMessageContent, processAttributeContent } from '../../bodies/mailchew';

/**
 * Process a bundle of events with the same UID so that there's a single message
 * for every current (highest "sequence") recurrent instance inside the current
 * sync window.  We call these "extrapolated events" for now, but there's
 * probably a better standard term for this.  We also store/retain all events
 * for which there was a `RECURRENCE-ID` which we'll call "concrete events".
 * (Which leaves the "recurring event (proper)" for the source of the
 * extrapolated events.)
 */
export class RecurringEventBundleChewer {
  constructor({ convId, uid, rangeOldestTS, rangeNewestTS, jcalEvents, oldConvInfo, oldMessages, foldersTOC }) {
    this.convId = convId;
    this.uid = uid;
    this.rangeOldestTS = rangeOldestTS;
    this.rangeNewestTS = rangeNewestTS;
    this.jcalEvents = jcalEvents;

    this.oldConvInfo = oldConvInfo;
    this.oldMessages = oldMessages;
    this.foldersTOC = foldersTOC;

    this.inboxFolder = foldersTOC.getCanonicalFolderByType('inbox');

    // This is a mapping from the message id we synthesize.
    const oldById = this.oldById = new Map();
    for (const old of oldMessages) {
      oldById.set(old.id, old);
    }

    this.unifiedEvents = [];

    // Reflects whether the last-modified changed and therefore event contents
    // could have changed (true) or whether this is just a date range expansion
    // (false).
    this.contentsChanged = true;

    this.modifiedMessageMap = new Map();
    this.newMessages = [];
    this.allMessages = [];
  }

  chewEventBundle() {
    // In cases where the calendar event was deleted, jcalEvents will be an
    // empty list now.
    if (!this.jcalEvents.length) {
      return;
    }

    // Hydrate the root component.
    this.rootComponent = new ICAL.Component([
      'vcalendar',
      [],
      this.jcalEvents,
    ]);

    // We sorted the events so the recurring event proper is the 0th
    // subcomponent.  The `ICAL.Event` constructor handles this by trying to
    // automatically find all related exceptions from its parent (our root), so
    // just wrapping the 0th into an Event should get us everything we need for
    // recurrence iteration.
    const rootEvent = new ICAL.Event(this.rootComponent.getFirstSubcomponent());

    // # Non-Recurring
    if (!rootEvent.isRecurring()) {
      // Don't bother emitting this event if it's outside our sync range.
      if (rootEvent.endDate.toJSDate().valueOf() < this.rangeOldestTS ||
          rootEvent.startDate.toJSDate().valueOf() > this.rangeNewestTS) {
        return;
      }

      // Wrap this into a fake `occurrenceDetails`
      const fakeOccur = {
        recurrenceId: rootEvent.startDate,
        item: rootEvent,
        startDate: rootEvent.startDate,
        endDate: rootEvent.endDate,
      };

      this._chewOccurrence(fakeOccur);
    }
    // # Recurring
    else {
      // ## Iterate the recurrence until it's past the end of our sync range.
      const calIter = rootEvent.iterator();

      // Failsafe infinite recursion avoidance.
      //
      // TODO: Remove this in the future, as the ical.js library in fact does
      // have its own invariants about making forward progress, but there have
      // been typos in this file before that led to sadness, and it's nice to
      // have a backstop.
      let stepCount = 0;

      for (calIter.next();
           (calIter.complete === false) &&
             (stepCount < 1024) &&
             (calIter.last.toJSDate().valueOf() <= this.rangeNewestTS);
           calIter.next(), stepCount++) {
        const curOccur = calIter.last;
        const occurInfo = rootEvent.getOccurrenceDetails(curOccur);

        // Skip to the next iteration if we're not yet into the sync range.
        //
        // (Although we are bounds-checking before/after here, we're doing it
        // for consistency.  The loop logic above should stop the loop once we
        // iterate beyond the end of rangeNewestTS.)
        if (occurInfo.endDate.toJSDate().valueOf() < this.rangeOldestTS ||
            occurInfo.startDate.toJSDate().valueOf() > this.rangeNewestTS) {
          continue;
        }
        this._chewOccurrence(occurInfo);
      }
    }
  }

  /**
   * Map a cal-address component representation to an `IdentityInfo` object.
   * This currently doesn't involve any external lookups, so this can be an
   * on-class helper, but if we wanted to grab data from elsewhere, this would
   * want to be a chewer class of its own like bugzilla's `chew_users.js`.
   */
  _chewCalAddress(calAddress) {
    if (!calAddress) {
      return {
        name: 'Omitted',
        address: '',
        nick: null,
      };
    }

    const cn = calAddress.getParameter('cn');
    const mailto = calAddress.getFirstValue().replace(/^mailto:/g, '');

    return {
      name: cn,
      address: mailto,
      nick: null,
    };
  }

  _chewOccurrence({ recurrenceId, item, startDate, endDate }) {
    // Padded for consistency with email (gmail) message id's.
    const msgId = `${this.convId}.${recurrenceId}.0`;
    const component = item.component;

    // If we've previously seen this event and our contents haven't changed,
    // then there's nothing to do.  In the future we could be more clever here
    // and attempt to hash over the contents in order to minimize generating
    // effectively no-op changes that generate busy-work.
    if (!this.contentsChanged && this.oldById.has(msgId)) {
      const oldInfo = this.oldById.get(msgId);
      this.allMessages.push(oldInfo);
      return;
    }

    let contentBlob, snippet, authoredBodySize;
    let bodyReps = [];

    // ## Generate an attr body part for the metadata
    {
      const attrs = [
        {
          name: 'Event',
          type: 'date-range',
          startDate,
          endDate,
        },
      ];
      if (component.hasProperty('location')) {
        attrs.push({
          name: 'Location',
          type: 'string-value',
          value: component.getFirstPropertyValue('location'),
        });
      }
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

    // ## Generate an HTML body part for the description
    let description = component.getFirstPropertyValue('description');
    if (description) {
      // At least as retrieved as a value, newlines are escaped.
      description = description.replace(/\\n/g, '\n');
      ({ contentBlob, snippet, authoredBodySize } = processMessageContent(
        description,
        'html',
        true, // isDownloaded
        true // generateSnippet
      ));

      bodyReps.push(mailRep.makeBodyPart({
        type: 'html',
        part: null,
        sizeEstimate: description.length,
        amountDownloaded: description.length,
        isDownloaded: true,
        _partInfo: null,
        contentBlob,
        authoredBodySize,
      }));
    }

    const summary = component.getFirstPropertyValue('summary');
    const organizer = this._chewCalAddress(component.getFirstProperty('organizer'));
    const attendees = component.getAllProperties('attendee').map(who => this._chewCalAddress(who));

    const msgInfo = mailRep.makeMessageInfo({
      id: msgId,
      umid: null,
      guid: null,
      date: startDate.toJSDate().valueOf(),
      author: organizer,
      to: attendees,
      flags: [],
      folderIds: new Set([this.inboxFolder.id]),
      subject: summary,
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

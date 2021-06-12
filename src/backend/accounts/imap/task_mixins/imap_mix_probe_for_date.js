import logic from 'logic';

import { makeDaysBefore, quantizeDate, DAY_MILLIS, NOW } from 'shared/date';
import { parseImapDateTime } from '../imapchew';

import { INITIAL_SYNC_GROWTH_DAYS, GROWTH_MESSAGE_COUNT_TARGET }
  from '../../../syncbase';

export default {
  /**
   * Figure out the right date to use for date-based sync by investigating
   * the INTERNALDATEs of messages that we ostensibly have not yet
   * synchronized.  This will err on the side of synchronizing fewer messages.
   *
   * The underlying assumption is that messages with higher sequence numbers
   * are more recent.  While this is generally true, there will also be
   * exceptions due to messages being moved between folders.  We want to
   * avoid being tricked into synchronizing way more messages than desired by
   * the presence of a bunch of recently added (to the folder) OLD messages.
   * We also want to minimize traffic and server burden while being fairly
   * simple.
   *
   * Our approach is to build a list of sequence numbers using an
   * exponentially growing step size, starting with a step size related to
   * our target growth size.  This gives us a number of data points from
   * messages that should be recent, plus a bounded number of points from
   * messages that should be old.  This lets us test our hypothesis that this
   * is a folder where message sequence numbers correlate with recent
   * messages.  If this does not appear to be the case, we are able to fall
   * back to just growing our sync range by a fixed time increment.
   *
   * We do not use UIDs because they have the same correlation but due to
   * numeric gaps and it being an error to explicitly reference a nonexistent
   * UID, it's not a viable option.
   */
  async _probeForDateUsingSequenceNumbers({
      ctx, account, folderInfo, startSeq, curDate }) {
    let probeStep = Math.ceil(GROWTH_MESSAGE_COUNT_TARGET / 4);
    // Scale factor for the step size after each step.  This must be an
    // integer or we need to add rounding logic in the loop.
    const PROBE_STEP_SCALE = 2;

    // - Generate the list of message sequences to probe.
    let seqs = [];
    for (let curSeq = startSeq;
         curSeq >= 1;
         curSeq -= probeStep, probeStep *= PROBE_STEP_SCALE) {
      seqs.push(curSeq);
    }

    let { result: messages } = await account.pimap.listMessages(
      ctx,
      folderInfo,
      seqs,
      [
        'INTERNALDATE',
      ],
      {}
    );

    // sort the messages by descending sequence number so our iteration path
    // should be backwards into time.
    messages.sort((a, b) => {
      return b['#'] - a['#'];
    });

    // In our loop we ratchet the checkDate past-wards as we find older
    // messages.  If we find a newer message as we move backwards, it's a
    // violation and we add the time-difference to our violationsDelta.  We
    // do this rather than just incrementing a violation count because small
    // regions of low-delta homogeneity at the beginning of the range are not
    // a huge problem.  It might make sense to scale this by the sequence
    // number distance, but the goal here is to know when to bail, not create
    // an awesome stastical model.
    let violationsDelta = 0;
    let checkDate = 0;
    for (let msg of messages) {
      let msgDate = parseImapDateTime(msg.internaldate);
      if (!checkDate) {
        checkDate = msgDate;
      } else if (msgDate > checkDate) {
        violationsDelta += msgDate - checkDate;
      } else {
        checkDate = msgDate;
      }
    }


    // 100% arbitrary.  But obviously if the folder is 10,000 messages all
    // from the same week, we're screwed no matter what.
    if (violationsDelta > 7 * DAY_MILLIS) {
      logic(
        ctx, 'dateProbeBail',
        { violationDays: Math.floor(violationsDelta / DAY_MILLIS) });

      // The folder's no good!  We can't do any better than just a fixed
      // time adjustment.
      return makeDaysBefore(curDate, INITIAL_SYNC_GROWTH_DAYS);
    }

    let useDate = quantizeDate(
      parseImapDateTime(
        messages[Math.min(messages.length - 1, 2)].internaldate));

    logic(
      ctx, 'dateProbeSuccess',
      {
        useDate,
        daysAgo: Math.floor((useDate - NOW()) / DAY_MILLIS),
        violationDays: Math.floor(violationsDelta / DAY_MILLIS)
      });

    // Woo, the folder is consistent with our assumptions and highly dubious
    // tests!
    return useDate;
  },
};

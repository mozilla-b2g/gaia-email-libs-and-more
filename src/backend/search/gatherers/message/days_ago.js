import { NOW, DAY_MILLIS } from 'shared/date';

/**
 * Compute the age of message in local-timezone-relative days in a hacky
 * fashion.
 *
 * We:
 * - compute the millisecond-since-epoch of the upcoming midnight and latch
 *   that so that our results will be consistent for messages even as time
 *   marches ever forward.
 * - subtract the message's date off of that, giving us how many milliseconds
 *   between the message's receipt and the end of today.
 * - divide that by the number of milliseconds in a day.  So a message from
 *   today at noon would be 0.5.
 * - We take the floor of that number.  So any message from today will end up
 *   0 days ago, any message from yesterday will end up 1 days ago, etc.
 * - If we ended up with a negative value due to the clock ticking over to
 *   tomorrow, we clamp it to 0 to avoid the negative values creeping in.
 *
 * Because of daylight savings time and such the better way to handle this would
 * be to create the actual Date object to determine the actual day and do the
 * math in that domain.  We almost certainly want to use a library for that.
 */
export default function DaysAgo(/* params, args */) {
  // start with now.
  let dateScratch = new Date(NOW());
  // round down to today's midnight.
  dateScratch.setHours(0, 0, 0, 0);
  // add a day to get tomorrow's hacky midnight and latch.
  this.tomorrowMidnight = dateScratch.valueOf() + DAY_MILLIS;
}
DaysAgo.prototype = {
  gather: function(gathered) {
    const { message } = gathered;

    let daysAgo =
      Math.floor((this.tomorrowMidnight - message.date) / DAY_MILLIS);
    if (daysAgo < 0) {
      daysAgo = 0;
    }

    return Promise.resolve(daysAgo);
  }
};

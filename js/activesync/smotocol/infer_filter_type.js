import logic from 'logic';

import $AirSync from 'activesync/codepages/AirSync';

import getFolderSyncKey from './get_folder_sync_key';
import getItemEstimate from './get_item_estimate';

/**
 * Compound protocol logic to guesstimate the best filter choice that will
 * result in the target number of messages being synchronized and automatically
 * select it, returning the filterType and the syncKey for that filterType.
 *
 * This is accomplished by (destructively) acquiring a sync key for the folder
 * using a 2-week filter, getting an estimate for that filter, then using math
 * and assuming a homogeneous message distribution to pick the right one.  If it
 * seems like we want more than a month's worth of messages, we try with no
 * filter in order to determine if that will result in bad news for us and then
 * decide between NoFilter and one month.
 *
 * Abstraction-level-wise, this is not a perfect fit for our protocol directory,
 * but it really doesn't need to be a task and does not commit to any GELAM
 * representations, so I'm leaving it in here.
 *
 * @return {{ syncKey, filterType }}
 */
export default async function inferFilterType(
  conn,
  { folderServerId, desiredMessageCount }) {
  const Type = $AirSync.Enums.FilterType;

  // -- Get a 2-week syncKey
  let filterType = Type.TwoWeeksBack;
  let { syncKey } = await getFolderSyncKey(
    conn, { folderServerId, filterType });

  // -- Get the item estimate for that 2-week syncKey
  let { estimate } = await getItemEstimate(
    conn, { folderSyncKey: syncKey, folderServerId, filterType });

  // -- Math!
  let messagesPerDay = estimate / 14; // Two weeks. Twoooo weeeeeeks.
  let desiredFilterType;

  if (estimate < 0) {
    desiredFilterType = Type.ThreeDaysBack;
  } else if (messagesPerDay >= desiredMessageCount) {
    desiredFilterType = Type.OneDayBack;
  } else if (messagesPerDay * 3 >= desiredMessageCount) {
    desiredFilterType = Type.ThreeDaysBack;
  } else if (messagesPerDay * 7 >= desiredMessageCount) {
    desiredFilterType = Type.OneWeekBack;
  } else if (messagesPerDay * 14 >= desiredMessageCount) {
    desiredFilterType = Type.TwoWeeksBack;
  } else if (messagesPerDay * 30 >= desiredMessageCount) {
    desiredFilterType = Type.OneMonthBack;
  } else {
    // -- Looking like one month isn't enough, try with NoFilter
    // We do a separate check here because this could turn out horribly for us
    // if the messages are not homogeneously distributed, like if this is an
    // archive folder that only contains messages older than a month.
    filterType = Type.NoFilter;
    syncKey = (await getFolderSyncKey(
      conn, { folderServerId, filterType })).syncKey;
    estimate = (await getItemEstimate(
      conn, { folderSyncKey: syncKey, folderServerId, filterType })).estimate;

    if (estimate > desiredMessageCount) {
      desiredFilterType = Type.OneMonthBack;
    }
    else {
      desiredFilterType = Type.NoFilter;
    }
  }

  if (filterType !== desiredFilterType) {
    filterType = desiredFilterType;
    syncKey = (await getFolderSyncKey(
      conn, { folderServerId, filterType })).syncKey;
  }

  logic(conn, 'inferFilterType', { filterType });
  return { filterType, syncKey };
}

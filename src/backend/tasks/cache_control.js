/**
 * This (global) complex task is responsible for tracking downloaded Blobs and
 * getting rid of them when appropriate, informed by usage hints.  Attachment
 * Blobs are tracked on a per-attachment basis, related parts are tracked as a
 * single entity.
 *
 * Our persistent state is an LRU Map where we leverage Maps' inherent ordering
 * to provide "free" LRU semantics.
 *
 * ## Operations ##
 *
 * ### Reserve ###
 * When a download operation is going to occur, it generates a 'reserve' task
 * telling us how much space it needs for the given MessageId.  This is space we
 * will keep reserved for the message until we see the attachments appear or the
 * reservation is revised down to zero.
 *
 * We require the reservation to explicitly happen prior to the download so we
 * can avoid temporary bloat situations.  Additionally, it allows us a future
 * path to user-prompting when necessary.  Specifically, we can make the
 * download execute steps depend on a resource like 'quota-available', and our
 * planning task could retract (or not make available) that resource if it
 * decides it needs to prompt the user to decide whether the quota should be
 * increased or whether they're okay with purging something they recently
 * downloaded.  But note that this is absolutely future work.
 *
 * ### Touch ###
 * When the user views a message with related parts or explicitly views/opens a
 * downloaded Blob, the front-end tells us so we can reorder the item in our LRU
 * list so it is the most-recently accessed.
 *
 * ### Newly cached/downloaded parts ###
 * When the download task completes, its database write generates a (hinted)
 * trigger notification that we listen for.  We are able to match up the
 * download to its reservation to clear the reservation and put the blob(s) in
 * the LRU map.
 *
 * The asymmetry between the reservation mechanism and this one is due to the
 * reservation being something we really do have to be told about, while the
 * Blob actually showing up is something we can notice via trigger.  Also, it
 * makes sense that other tasks may want to run as a result of an attachment
 * download (ex: thumbnailing of images or calendar integration or something
 * like that), so we want there to only be one code path for that.
 *
 * ### Deleted Messages ###
 * We use a database trigger to notice when a message is deleted and accordingly
 * remove any associated cache entries (and the associated disk usage) from our
 * tracking and to free up quota.
 *
 * ## Interaction With Other Quota Mechanisms, ex: Header/Body overhead ##
 *
 * We don't interact yet.  There are currently no in-backend mechanisms for
 * tracking or estimating the disk/quota used for synchronized messages and
 * conversations.
 *
 * In the future, if we can get IndexedDB to tell us the overall quota we're
 * using, we can subtract off what we know about in here and assume the rest is
 * synced messages/conversations.
 */

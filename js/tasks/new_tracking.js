define(function(require) {
'use strict';

const co = require('co');

const TaskDefiner = require('../task_infra/task_definer');

/**
 * Per-account tracking of "new" messages and the conversations they belong to.
 * We use the trigger mechanism to listen for new messages and for changes to
 * messages to know when a message is no longer new.
 *
 * Our rules for newness are quite simple:
 * - A message is new if, as part of a sync, it is newer than the previously
 *   known newest message (per INTERNALDATE rules) during our last sync, in the
 *   inbox, and unread.  This could also be thought of as saying that a message
 *   that we are learning about as a result of growing our sync window back in
 *   time or that appears to have been moved to the inbox from another folder
 *   (and therefore already seen) cannot be new.
 * - A message ceases to be new if we synchronize it and it becomes read.
 * - The entire set of new messages is cleared when the front-end tells us to
 *   clear the set.  It does this when the user views the relevant inbox.
 *
 * Conceptually, it feels wrong to call this a "task".  It feels more right to
 * think of newness as a per-message flag.  But our decision is made for us by
 * the data access patterns:
 * - We expect the set of new messages to be reasonably bounded in size.  We are
 *   able to implement LRU eviction or overload modes because as the set size
 *   grows, the benefit to the user decreases.  "Everything is new!" is not
 *   a useful distinction.  This means that it's reasonable to use a small set
 *   representation that is persisted to disk atomically and maintained
 *   in-memory.
 * - We explicitly do not expect to need to present a TOC for "only the new
 *   messages", although a search filter could be constructed efficiently from
 *   our set representation.
 * - Per our UX, we clear the set all at once.  We also expect this dance to
 *   play out over and over: new, clear, new, clear, new, clear.  Storing the
 *   information on the messages/conversations and on secondary indices induces
 *   a non-trivial amount of overhead and change deltas.  In contrast, this is
 *   exactly what the overlay mechanism and its coupling to the task
 *   infrastructure was designed to be used for.
 * - We can't simply use a range characterized by a timestamp because messages
 *   are marked non-new as they are read on other devices.  (This would also
 *   assume that we have an index over messages by INTERNALDATE, something we do
 *   not have at this time, although it may eventually happen.)
 * The following are neutral points:
 * - In this world of multiple devices, we do expect for it to be common that a
 *   user may read messages on other devices and for us to therefore end up
 *   removing the newness of many messages.  Since a message only becomes un-new
 *   by being read and we've already loaded the the message from disk at that
 *   point and will mutate it, the set represntation doesn't have any great
 *   advantage other than avoiding the derived indices.
 *
 * ## Newness Determination in Triggers ##
 *
 * We cache the inbox folder for each account as part of our memoryState.  This
 * allows us to efficiently determine if a message both belongs to our account
 * and is in the inbox just on the basis of the folders it belongs to.  (The
 * account's inbox is exclusively contained within the account.)
 *
 * The "is it new?" determination is trickier because although the INTERNALDATE
 * comparison is simple, knowing when to update the comparison value is not
 * thanks to our fragmentation of the sync process.  New messages are added to
 * the database as the result of tasks spun off from the initial sync_refresh
 * or sync_grow, all of which will occur strictly after the lastSyncedAt values
 * on the folder are stamped, etc.  Additionally, we want to avoid having clock
 * skew issues between ourselves and the server corrupt our concept of newness.
 *
 * At a high-level, however, our goal is clear.  We want to update the
 * comparison value at the end of each logical sync operation and use it for
 * the entire duration of the next sync operation.  Happily, task groups track
 * this for us perfectly.  In fact, task groups will even handle the case where
 * a sync_refresh's spin-off tasks are still being processed and a new
 * sync_refresh is introduced; they will all receive the same task label.  The
 * only real complexity is that since task groups can be hierarchically nested
 * we want to ensure that if we refer to task groups that we're referring to the
 * sync_refresh's group or higher.
 *
 * This provides us with our implementation approach.  We persistently track the
 * current comparison INTERNALDATE and the highest INTERNALDATE we've seen for
 * the current task group.  When we receive an 'add' trigger that is for our
 * inbox, we check the active root task group.  If it's different from the last
 * task group in this case, then we know we've encountered a new sync and should
 * apply the accumulated high INTERNALDATE to our persistentState and use it as
 * the new comparison value.  If it's the same task group then we just need to
 * to potentially update our pending high INTERNALDATE.
 *
 * We deal with the lack of an explicit event when the end of the sync happens
 * by having persisted the pending high INTERNALDATE too.  The bad case for us
 * would be if a sync completes and our app shuts down and then we start up
 * again and a sync happens and we fail to update our comparison date.  By
 * persisting the pending value and having our "did the task group change" logic
 * be compelled to notice a change when freshly restarted, we can ensure
 * correctness.  To this end we don't persist the task group id and instead
 * store the group id in memoryState to avoid any problems from reuse of task
 * group id's.
 *
 * ## Data Structure ##
 */
return TaskDefiner.defineComplexTask([
  {
    name: 'new_tracking',

    'trigger_msg!*!add': function(persistentState, memoryState, triggerModify,
                                  message) {

    },

    'trigger_msg!*!change': function(persistentState, memoryState, triggerModify,
                                     messageId, preInfo, message, added, kept, removed) {

    }
  }
]);
});

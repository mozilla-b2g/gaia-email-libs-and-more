define(function (require) {

/**
 * Our new gmail sync is also when we avail ourselves of using a more granular
 * scheduling mechanism for sync, reminiscent of Thunderbird's fetch queue for
 * offline sync (biased towards fetching newer/smaller messages) and gloda's
 * explicit named tasks and nested generators.  This becomes more important for
 * us as we potentially end up with multiple concurrent synchronization goals
 * happening in parallel, and with relative importance varying over time as the
 * user does things in the UI.
 *
 * In sync, the things that can happen amount to:
 * - folder sync (where we learn about new/missing UIDs/conversation id's):
 *  - expand our covered synchronized date range (including initial sync)
 *  - refresh/update our covered sync range using CONDSTORE
 *  - deletion inference over our date range(s)
 * - ensure we know about a given conversation and, if not, process it
 * - fetch message envelopes (in a conversation)
 * - fetch message snippets (for messages in a coversation)
 * - fetch message bodies
 *
 * ### Sync life cycle ###
 *
 * Our message-centric sync process would give up when it lost its connection.
 * This was sane and reasonable since our folder state also served exactly as
 * our synchronization state and our invariants about header/body existence were
 * straightforward.  There were no complicated aggregate constructs like
 * conversations or possibility for the lifetimes of the synchronized data to be
 * decoupled from the per-folder sync state.  That has all changed.
 *
 * With that change comes the possibility of the new situation where we either
 * need to persist in-progress work or abandon in-progress work.  Abandoning
 * potentially risks situations where we never make any forward progress and can
 * waste bandwidth, and is not desirable.  However, persisting in-progress work
 * increases the probability we'll attempt to do something that is now moot
 * because things changed while we were offline.  Of course, the reality is that
 * we need to handle this anyways.
 *
 * ### Namespaces for mooting, priorities, de-duplication, and dependencies ###
 *
 * We use a unified namespace to express what a task is operating on for
 * prioritization and mooting purposes.  For example, if a user is looking at
 * a conversation, fetching the headers in a conversation or their snippets
 * becomes much more important than other possible things we could do.
 *
 * Likewise, if we know that a conversation no longer exists or shortly won't
 * exist because the user issued a request to delete it, it makes sense to
 * moot those tasks into oblivion.  (Or at least transfer them to be blocked
 * pending the operation of the deletion operation, in case it gets undone/
 * cancelled prior to executing.)
 *
 * We can also use a similar rationale to avoid having duplicate tasks
 * scheduled while allowing whatever was requesting the duplicated tasks to
 * properly depend on the result of an existing task.  This allows us to avoid
 * overhead of duplicated snippet requests, or to ensure that if we decide to
 * synchronize two folders in parallel that they won't go duplicating work or
 * otherwise fight each other.
 *
 * ### Database coherency ###
 *
 * Tasks should be structured so that they only ever update the (apparent)
 * database state when they are completing.  In that transaction the task will
 * be removed from the database and its results added.
 *
 * ### User Actions, Undo, Consolidation ###
 *
 * Our previous job-op mechanism was somewhat heavy-weight, with each job-op
 * tracking local and server state and desired local and server state, plus
 * various error handling.  We now decouple user intent from the tasks, although
 * the underlying logic ends up being similar.  Although there are many
 * benefits from this simplification, the primary one is that it allows us to
 * explicitly decouple the undo-stack from the task queue which has major wins
 * for keeping the task queue small in the face of an offline user randomly
 * performing an endless series of operations.
 *
 * Some tasks involve complex state, such as modifying message flags.  While we
 * could always split out the flag modifications into separate tasks so the
 * concept of mooting/negation can easily operate in our single namespace, it
 * of course is not efficient and may even be semantically troubling to the
 * server for us to issue the requests independently.  We could aggregate the
 * tasks when we actually go to run them, but that begs the question of why we
 * aren't just consolidating them up front.
 *
 * And so we implement consolidation.  There is a single namespace name for
 * modifying the flags/labels of a message.  When a new request is issued and
 * there is an existing task (that has not yet begun running), the consolidation
 * logic updates the task to the new desired state.  NB: If the task is actively
 * doing something, we will defer unifying/consolidating the request until the
 * task has finished what it is doing.
 *
 * ### But what about batching? ###
 *
 * IMAP allows us to issue the same command for a set of messages concisely.
 * And the FxOS email app lets the user perform bulk manipulations, so it's a
 * possible thing.
 *
 * ### Parallelism ###
 *
 * Local database operations are inherently serialized, so for both sanity and
 * efficiency
 *
 * ### (Simple) Local Operations are Non-persisted ###
 *
 * It would be silly to persist a task for which the overhead of recording the
 * task in the database is the same as the overhead for performing the task.  Of
 * course these may still potentially result in
 *
 */



function GmailSync() {

}
GmailSync.prototype = {
  syncFolder: namedTask('syncFolder',
                        function* syncFolder(folderSyncDB, convDB) {
  })
};

return GmailSync;
});

The great and powerful MailDB database!

## Responsibilities ##

Responsible for:
- Caching. Consumer code should *not* grow caching logic.
- Events.  All database manipulations result in synchronous notifications
  immediately following the completion of the actual IndexedDB request
  dispatching.
- Avoiding/detecting data-races.
- Maintaining index-like tables.  IndexedDB indices are somewhat limited right
  now to using key paths, so in some cases we need to do the legwork

## Mutation and data races ##

### Motivating Goals ###

We want:
- To avoid broad mutexes
- To avoid later having to deal with horrible bugs with subtle data corruption
  due to races or inconsistent locking disciplines.
- To have efficient I/O patterns

### This is how we do it... ###

When you ask us for data, you are asking either for read-only purposes or you
are asking because you want to mutate the data.  If you are asking for mutation
purposes, you must be a task and you inherently acquire a mutation lock against
that data attributed to your task.  You ask for all mutation requests at the
same time in your task, thereby ensuring a consistent locking discipline.  (If
any request is against something with an already-held mutation lock, you wait
for that task to complete and a serious warning is generated since this
likely constitutes a bug that needs to be addressed with additional task
constraints or more significant implementation change.)

When data is retrieved for mutation purposes, if we maintain any index-like
tables for the record, we will snapshot them so that we can do any delta
inference when you complete the write process.

If the task is aborted, all resources associated with the task are released
without changes.

## Caching ##

Reads and writes populate the caches.  The caches can and will be discarded, but
we will fire an event before we do this.  This gives logic dealing in batched /
coalesced changes (ex: windows list views) the opportunity to be lazy about
processing changed state until either they want to flush or we're going to
discard data they might need.

Cache Maps are directly exposed on the database.  Callers are allowed to do
read-only stuff with them.

## Events ##

All changes to the database generate a series of events.  Previously (v1/v2),
the mailuniverse handled the non-mailslice events, propagating the calls amongst
the various mailbridge instances which then owned the relevant slice models.  We
now simply do all the event routing here and the various `*_toc` classes take
care of exposing that for view-slice purposes.  The mailbridge also directly
registers non-slice per-id listeners.

We use the same namespace conventions used by the task manager to cram stuff
into a single string address space.  (Note that we do have a generational GC
in Gecko now, so we aren't expecting the temporary strings to be the end of the
world.)

We generate two types of events for two types of consumers:
1. TOCs: These cover add, changes, and removal.  They are scoped to the list
   views we have.
2. Item-listeners: Changes to and removal of specific items.  Fully qualified
   identifiers are used.

You may wonder about things that logically follow as the consequence of
something else.  For example, when we create a new account we want to
synchronize the account's folder list immediately and then we immediately want
to trigger synchronization of the account's inbox.  That is handled by the task
infrastructure.  You don't listen for a database change of an account being
added and then schedule the task.  The task definitions / meta-data cause the
task manager to do that for you.

### TOC events ###

- `accounts!tocChange`
- `acct!AccountId!folders!tocChange`
- `fldr!FolderId!convs!tocChange`
- `conv!ConvSuid!messages!tocChange`

Note that there are potentially other TOC implementations out there, but since
their representations aren't directly mapped to the database, we aren't involved
in their events.  For example, the list of pending downloads is maintained in
tasks, so that's what the TOC implementation would hang off of.

### Item listener events ###

- `acct!AccountId!change`
- `fldr!FolderId!change`
- `conv!ConversationId!change`
- `msg!MessageId!change`
- `tach!MessageId!AttId!change`

### Cache events ###

- `cacheDrop`: We are about to discard some stuff from our cache.  If you care,
  you should do all the synchronous-cache-consuming stuff you need to do RIGHT
  NOW during this event.  After this event, you will very possibly be looking at
  having to issue database loads.

### Event Ordering and Commits ###

We issue events as the write transactions are issued.  We do this because it
means our UI doesn't need to wait for writes to complete which makes us seem
happy and responsive.  (At least as long as our tasks don't wait for the write
transactions to notify completion.  If we're waiting, we potentially end up just
having the UI speculatively one commit ahead of what the disk sees.)

The impact on data loads is they need to buffer the mutation notifications until
the load completes.  We build convenience helpers into the database to help with
this boilerplate.

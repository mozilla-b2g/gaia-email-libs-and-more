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
that data attributed to your task.

When data is retrieved for mutation purposes, if we maintain any index-like
tables for the record, we will snapshot them so that we can do any delta
inference when you complete the write process.

If the task is aborted, all resources associated with the task are released
without changes.

## Memory Ownership of Data ##

We have two data management strategies:
* Memory-resident.
* Loaded-on-demand.

### Memory Resident ###

This is data that has a relatively low cost, is frequently used, and that
potentially becomes a logistical nightmare for tasks to have to potentially wait
for database reads to occur.

These are:
* Account Definitions.  (Note that this doesn't mean the Account is instantiated
  at all times.  It is not.)
* FolderInfo: The per-folder metadata that describes the folder.  This does not
  include its synchronization state which can be very large and expensive.
* Task State.  Especially since we dynamically reprioritize tasks as situations
  change, we have to know all the things we need to do.  This is also important
  for our overlay mechanism where we want to be able to synchronously consult
  pending tasks.  Note that tasks are expected to use loaded-on-demand storage
  where appropriate, whether it be via platform Blob support or separate
  database storage.

All manipulations are still atomic in nature.  Everything occurs as part of a
task, and all writes are issued as part of a transaction.

#### Atomic Manipulations of Memory-Resident Data ####

Our rules for loaded-on-demand data allow for write-locks to be held through
multiple turns of the event loop while waiting on disk I/O.  In the face of
task parallelism, this can result in lock contention.

For our memory-resident data, we could use the same locking discipline, but we
don't really need to.  There are effectively three ways to ensure data
consistency for our purposes:

1. Unbounded duration write-locks.  Only one piece of code has the write-lock at
   a time, and it holds the lock until it releases it.
2. Bounded duration write-locks.  The idiom where the caller provides a function
   to invoke and manipulation is only allowed until the callee returns (and
   nested event loops are forbidden).
3. The desired manipulations are described and a helper mechanism is responsible
   for applying them to the data in an atomic fashion.

Unbounded duration write-locks are what we use for our loaded-on-demand data.
Bounded duration write-locks are only viable in an atomic transaction model if
they are only applied immediately prior to issuing (and completing) the write
transaction.  This is tractable as long as there are no data inter-dependencies,
but the code can look weird, there's a potential to screw it up with buggy code,
and it's arguably harder to unit test than describing the manipulations.

The third option, describing the manipulations, is effectively isomorphic to
bounded duration write-locks if the manipulations are all simple.  Additionally,
it allows for distributed map-reduce style processing on multiple threads or
otherwise persisting the manipulation as a "to-do".  This allows a task to
atomically complete even while a longer-lived orthogonal task with an unbounded
duration write-lock on the same object still is active.  (Orthogonal is really
key here.  Currently our IndexedDB usage would not actually allow this to occur,
but it's something to aspire to.)

And so... for our manipulations of our memory-resident data, we use/support
the "desired manipulation" mechanism, with our descriptions covering
"clobbering" (assignment that doesn't care what was there before), and "deltas"
(increment/decrement).

### Loaded-on-demand ###

Everything else is expected to be read from the database as-needed, with write
locks being obtained for data only after any dependent network traffic has
occurred in order to avoid stalling task planning on a network-using `execute`
stage.  In other words, we want write-locks to only be held during a time
period when the task has become (disk) I/O bound.

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

We generate three types of events for two types of consumers:
1. TOCs: These cover add, changes, and removal.  They are scoped to the list
   views we have.
2. Item-listeners: Changes to and removal of specific items.  Fully qualified
   identifiers are used.
3. Triggers: Unscoped events generated for every change.

You may wonder about things that logically follow as the consequence of
something else.  For example, when we create a new account we want to
synchronize the account's folder list immediately and then we immediately want
to trigger synchronization of the account's inbox.  That is handled by the task
infrastructure.  You don't listen for a database change of an account being
added and then schedule the task.  The task definitions / meta-data cause the
task manager to do that for you.

### TOC events ###

- `accounts!tocChange`: accounts add/change/remove
- `acct!AccountId!folders!tocChange`: folders add/change/remove on an account
- `fldr!FolderId!convs!tocChange`: conversations add/change/remove in a folder.
  Arguments:
- `conv!ConvSuid!messages!tocChange`: messages add/change/remove in a conv
  Arguments: [messageId, preDate, postDate, message, freshlyAdded]

Note that there are potentially other TOC implementations out there, but since
their representations aren't directly mapped to the database, we aren't involved
in their events.  For example, the list of pending downloads is maintained in
tasks, so that's what the TOC implementation would hang off of.

### Item listener events ###

- `acct!AccountId!change`
- `fldr!FolderId!change`
- `conv!ConversationId!change`: Fired when the conversation (summary) changes.
  Arguments: [convId, convInfo].
- `msg!MessageId!change`: Fired for changes to existing messages as well as
  their removal.  Arguments: [messageId, message].  In the case of removal,
  the message argument will be null.
- `msg!MessageId!remove`: Fired when the given message is removed.  Arguments:
   [messageId].

### Trigger events ###
These events provide the maximum amount of information possible to the listener.

- `conv!*!add`: The conversation came into existence.  Arguments: [convInfo]
- `conv!*!change`: The conversation was modified.  Arguments: [convId, preInfo,
  convInfo, foldersAdded, foldersKept, foldersRemoved].
- `msg!*!add`: The message came into existence.  Arguments: [message]
- `msg!*!change`: The message was changed or removed.  Arguments: [messageId,
  preInfo, message, foldersAdded, foldersKept, foldersRemoved].  In the case of
  removal, the message argument will be null.
- `msg!*!remove`: The message was removed.  Note that if you want changes too,
  the change event already covers removal.  Use this is you only want removal.
  Arguments: [messageId].
- `tach!*!download`: TODO: An attachment was fully downloaded.  Arguments:
  [message, part].  This does not fire for embedded parts.  TODO-wise, I'm not
  yet sure how to best know when to fire this event.  I'm leaning towards
  explicit hinting because the attachment state management is already so
  convoluted and so false positives seem quite possible and the cost is also
  not entirely trivial.  (Immutable reps would be ideal and maybe a good idea,
  but scope-wise not appropriate at this instant.)

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

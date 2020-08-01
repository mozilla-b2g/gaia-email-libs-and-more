## Prioritization ##

We want to prioritize tasks like so (says asuth):
1. Stuff the user is currently looking at.
2. Sending emails / other time-important communication with other humans.
3. Stuff the user will soon be looking at.
4. Applying local state to the server (flag changes, saving drafts, etc.)
5. Speculative synchronization stuff.

Tasks are tagged with prioritization tags in a unified namespace.  Some of these
have static values assigned like "send-email" that never change.  Others are
parameterized and get their boosts based on what the front-ends tell us about
the user's focus.

For example, all sync tasks for the inbox might have priority tag
"view:folder:0.0" assigned (where 0/0 is the folderId for the first account's
inbox.)  While the user looks at the inbox, the priority assigned to this tag
will be high.  But if the user clicks on a conversation for a conversation that
tag will be deprioritized and the front-end will register a high-priority on
"view:conv:0.42".  Tasks specifically related to synchronizing the conversation
will have this tag but also will include other static tags to affect their
priority level.  In the case of snippet-fetching, we want snippets for all of
the messages in a conversation, but the most important one to us is the message
that the conversation summarizing will use as the snippet to show for the
conversation.  Accordingly it gets a "conversation-snippet" priority tag unique
amongst all its sibling messages.

### Relative priorities and priority tags ###

The priority needs to end up being an integer.  Divvying up a numeric priority
space historically is a mess.  (See CSS z-index for example.)

So the only numerical assignment done by tasks is to indicate a `relPriority`
which is intended for use by tasks of a single type to differentiate amongst
themselves.  For example, sync_refresh/sync_grow will generate a number of
sync_conv tasks.  We want the more recent conversations to be prioritized, and
the sync_conv task can accomplish that itself by assigning a `relPriority`.

The `relPriority` should be a value in the range [-99999, 99999] where more
positive values are prioritized first.

For all other prioritization, priority tags are used.  These are a combination
of simple, static tags like `send` and `sync` that can be messed with in a
single, centralized place, plus the dynamic priority tags.

### Dependencies and Priorities ###

Example: We want to save a draft of a message.  We need to ensure there is a
drafts folder and create it if there is not.  And we may need to sync the folder
list before doing so if we haven't synced it recently/ever.

## Scheduling, Persistence, Database Coherency, and Task Life-Cycles ##

### Goals ###

Acceptable Limitations:
- We accept that the possibility of a < 1 second time window of vulnerability
  between the user triggering some action and their intent being durably
  committed to the database.  Because we do expect system activity to sometimes
  result in us being starved of CPU or I/O, we should only intentionally depend
  on up to 100ms.

Goals:
- Avoid obviously inefficient database patterns when possible, batching where
  reasonable and safe.  (But we should not be afraid of issuing transactions,
  especially if the alternative is to introduce complicated logic to emulate
  logic IndexedDB would give us for free.  Our IndexedDB implementation has
  undergone and is undergoing various performance improvements we can leverage
  or put our effort into instead.)
- *Never* lose data / task state once we have persisted our intent to do
  something.
- Be memory efficient and able to tune our trade-offs between memory use and
  disk-efficiency.

So... We need to never forget a task until it has come to fruition.  AKA
inopportune killing of our process or power loss should never result in task
loss unless IndexedDB is violating its spec / what :bent told us it should do.

### Simultaneous Completion and Application of Side-Effects ###

Realish example.  My task is to buy a soda.  The task is complete in the instant
where I durably hand the shop-keeper the exact change, they hand me my soda, and
I somehow also clean the marker off my arm where I wrote that I need to buy a
soda.  It's all or nothing.  There's no situation where I end up having
forgotten needing to get the soda, or I still have the money but also have the
soda, or lost the money and didn't get my sweet, sweet, soda.

Implementation-wise, this means that when the task completes it applies all of
its database mutations in a single transaction and a single turn of the event
loop.

There are cases where our task may involve doing something that exists outside
of our database state and can't be made efficiently idempotent.  For our even
more real example, let's consider moving an IMAP message.

On some servers we have a MOVE command and it is atomic.  In the event our task
runs and we issue the MOVE command but our process is killed, when we go to run
the operation next time, we are efficiently able to behave idempotently since
the MOVE command will fail because the message is no longer there and our system
re-triggered our task.  Once we notice that failed, we can work to rectify the
situation by scheduling some other task to do whatever needs to be done now
(like figure out the UID of the message in the target folder and/or otherwise
make our state coherent.)

On other (sucky) servers, we need to copy the message followed by the deletion
of the message from its source location.  If our process is killed in the middle
of this, we may have copied the message but not deleted it.  In that case, when
we try to run the command again if we naively repeat our logic, we can end up
duplicating the message (especially on a UIDPLUS-enabled server).  We can
generically address this situation by scheduling a task that handles this
ambiguous situation and ensuring it's sufficiently persisted to disk before
actually doing anything with non-idempotent-ish side-effects.  And then we moot
that task as part of successfully completing the task.

### Task Life-Cycles ###

Tasks have the following life-cycle states/transitions:
- Raw: This is the form that the call to `scheduleTask` accepts.  No
  per-task code has run against the task at all.  We can and will persist this
  representation to disk, especially as part of task completion.  In many ways
  this is the API for the task.  (Note that when persisted to disk the raw task
  will be wrapped in an object providing metadata.)
- Planning: The task logic asynchronously processes the raw request and when it
  completes it will have:
  - Made any changes to local database state, like marking a message as read,
    etc.
  - Produced the raw request(s) that should be scheduled to undo this task.
    (Remember that the task infrastructure itself does not directly care about
    undoing things.  It's handled at a higher level of abstraction.)  Note that
    undoing is not just the inverse of this request.  For example, if you
    request to mark a message as read that is already marked read, there is
    nothing to undo!
  - Integrated the request into the task's persistent state.  For simple tasks
    this is a new record that gets added to a list, for complex tasks this means
    updating whatever representation the complex task maintains for itself.
  - Figured out the priority / priority tags of this action.
  It will not have:
  - Done anything involving the network or user interaction.  Planning is
    largely analogous to the 'local' part of the old job-op implementation.
  - Done anything particularly resource-intensive.  We plan all tasks as quickly
    as possible.  We then execute them based on our priority hierarchy.  If you
    are going to need a lot of memory or to do a lot of disk I/O, you do that in
    the execution phase of your task.  And maybe you break your task into
    multiple tasks.
- Blocked: Planned tasks/markers indicate the resources they require to be able
  to execute, such as their owning account being online.  They are blocked and
  not considered for execution until the resources become available.  Tasks may
  also be blocked awaiting a backoff-based retry.
- Execution: The task manager eventually decides to execute your task based on
  its priority / resource needs / dependencies / etc.

## Complex Tasks ##

Complex tasks are responsible for maintaining their own (aggregate) state as a
persistent, atomic state.  Given this state, they assert a set of task markers
with priority tags.  The task manager treats these task markers like planned
simple tasks, consuming them in the same fashion.  But when the TaskManager
decides to execute a complex task, it instead hands the complex task a task
marker.

Task markers have an associated count in order to allow for parallelization.

I recently introduced support for complex tasks being able to asynchronously
initiate themselves, in case they want to extract state from messages/etc. for
the outbox, but then I ended up not using it.  I think we should try and avoid
using this functionality since it seems likely to result in bad complexity, but
there's nothing fundamentally wrong with it.  So if it seems like the best
strategy to use, it's available.  Just think about it and factor in the overlay
implications.

## Blocking: Resources and Timeouts/Backoffs ##

We may not be able to execute tasks at the current time, or we may not want to
execute them until after some interval of time has passed.

Our core use cases are as follows:
- Don't try and do online-only things when we're not online.
- Don't do things when there are known account problems:
  - User-action required, such as due to a bad password/oauth credentials.
  - Apparent server outage.
- Retry an action after a timeout.  (For cases where we otherwise think the
  network is online and the server should generally be working, but that we
  might have been facing a transient failure.)

Some enhancements we could use resources for in the future:
- Defer heavier-weight attachment downloads to wi-fi.

### Resource Naming Conventions and Priorities ###

We name resources consistent with how we report problems to the user.  We could
define fewer resources if we conflated a lot of things just into "is this
account happy or not?", but that doesn't help us explain to the front-end and
the user what the problem is.

For accounts, we have the following resources defined in order of severity:
- 'online': We have a global concept of being online.  In order to do things
  like sync an account, we need to be online. Sync-related tasks will report
  they are syncBlocked because they are 'offline' if this resource is not
  available for their account.
- 'credentials!<AccountId>': To do anything online with an account, we need to
  believe we have valid credentials for the account.  Sync-related tasks will
  report 'bad-auth' if this resource is not available for their account.
- 'happy!<AccountId>':


To simplify the number of resource dependencies each task needs, although we
have an "online" resource for catch-all purposes, we all have each account
expose an "online!account!${accountId}" resource that is only exposed when we
are online and the account is not disabled by a persistent problem like a bad
password.

### Timeouts ###

TaskResources provides a restoreResourceAfterTimeout method to automatically put
a resource back in place after some delay.

Currently this is implemented as a naive setTimeout, but in the future it could
end up with (optional) mozAlarm support which could re-trigger the app.  We need
more explicit use-cases and rationale before we add this complexity.  In many
cases it's possible that emerging APIs like BackgroundSync or requestsync may
satisfy our wakeup needs more appropriately and they should just be Integrated
instead.

## Wake-Locks ##

Tasks do not manage wake-locks themselves.  The TaskManager is responsible for
holding cpu and wifi wake-locks as appropriate.  While there are tasks to
be planned/executed and forward progress can be made, a cpu wake-lock is held.
While there are tasks that require network access, a wifi wake-lock is held.

Note that there's a lot of complexity related to cellular data versus wi-fi and
B2G's wi-fi connection logic that is out of our hands and generally not great.
Our two main issues are:
- Accidentally causing a transition from cellular data to wi-fi data by
  acquiring a wifi wake-lock.
- Not having any network connection, but being able to get one if we acquire
  a wifi wake-lock and then wait for a while.  This is something we've avoided
  doing because it's complexity we really shouldn't have to deal with.

## Undo Support ##

The planning stage of task processing generates a list of raw tasks that,
when planned, will undo the side-effects of the current task.  (A single task
may expand to multiple undo tasks because although the desired target state may
be simple, the current source state may be very complex.)  This can all be a bit
complex to implement both correctly and efficiently, so our initial game plan is
to potentially be wildly inefficient when undoing things.

The request to generate and return undo data is issued as part of the raw task
itself.  This results in the Promise being resolved with the list of raw undo
tasks being returned.  The tentative plan is to send them over the wire to the
front-end to avoid having mutation operations generating garbage that requires
active participation from the consumer to not leak.  By just updating the
return value of the MailAPI request and then forgetting about it, JS GC handles
things for us.

The downside to this approach is that it provides a path for the front-end logic
to directly request raw task scheduling.  We make almost no effort to protect
against a hostile front-end (and indeed we cannot protect against it at this
time), but it's worth noting since we may desire to expose a somewhat hardened
API in the future for extensions in order to avoid having internals become de
facto APIs that are hard to change.

## Events ##

Emitted on TaskManager:
- planned:TASKID(returnedResult)
- planned(taskId, returnedResult)
- executed:TASKID(returnedResult)
- executed(taskId, returnedResult)

## Errors and Retries ##

All tasks are wrapped into a promise (usually using generators and co.wrap under
the hood).  If the promise is rejected, we treat it as an error.

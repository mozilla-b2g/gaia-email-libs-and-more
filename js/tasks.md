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
- Execution: The task manager eventually decides to execute your task based on
  its priority / resource needs / dependencies / etc.

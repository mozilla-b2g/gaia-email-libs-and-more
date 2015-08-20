## Drafts-on-server ##

### Goals ###

Most important first:

1. Don't lose user-authored content.
2. Don't waste boatloads of data.  Specifically, don't be uploading large
   attachments to the server over and over and over.
3. Try and be prompt about updating drafts on the server.

### Important simplifications ###

- Drafts are not a complicated version control system; we do not need a clever
  conflict-resolution logic.  We just need to err on the side of duplicating
  data over losing it.
  - If a draft is modified by another client, it will necessarily replace the
    prior draft with a new message.  Our sync logic should appropriately purge
    our local message unless our message has changed.
  - In the event of suck a "forking", it's acceptable for us to re-assert our
    draft to the server as long as we then reach a steady-state where the
    subsequent deletion of that draft by another client will purge it from our
    set of drafts when synchronized.

### Our strategy ###

- Drafts are eagerly saved locally.
- Drafts that have not had their state persisted to the server are effectively
  unknown to the sync logic system and so cannot be deleted as the result of
  synchronization.
- Draft uploading is lazy.  The MIME body for a draft is not created until we
  are actually executing the task.
- When a draft is saved to the server, the draft is fixed-up to have sync state.

### The outbox, complex state, and notional folders ###

The v1.x outbox was a local only folder that effectively captured complex task
state rather than depending on the (poorly suited for that task) job-op queue.

Now that we have complex task state, it begs the question of whether it's
appropriate to have the folder behave in a magical fashion or whether the
authoritative data for the "send me" list should be in a complex task state
that happens to be reflected.

The answer?  Complex state.  Why?:
- Because of the conversation view, the magical nature of the current folder is
  no longer sufficient for the UI to display the right thing.  It needs to know
  on a per-message basis what is a draft or what is currently queued to be sent
  or is actively being sent.
  - Queued to be sent / actively being sent implies overlay mechanisms or other
    meta-data that exists at a finer granularity than labels/folders support.
- In v1.x messages in the outbox already had more complex state than just being
  in the outbox.  They also had a sendStatus and could have errors, etc.  This
  is an argument for tracking the status in a separate and explicit data
  structure that exists orthogonally to the message data.  (AKA store task
  state in a task, don't just keep randomly adding data to the the message.
  Noting that this absolutely depends on overlays and was not a viable option
  in v1.x and the v1.x decision was the right one.)

### The naming/id problem ###

The server name for a draft changes each time we save it since we must create a
new message-id header and a new UID will be allocated.  Happily, the adoption of
"umid" identifiers with corresponding indirection largely addresses this need.

### Tasks and Flows ###

- draft_create creates a new local message, be it a blank message or a reply or
  forward of an existing message.
- draft_save updates the local message's non-attachment state.  That is, the
  sending identity, recipients, subject, and body are updated.  Attachments
  are instead manipulated using draft_attach and draft_detach.
  - When we implement saving drafts to the server, the save process will also
    result in a draft_upload task being enqueued.
- draft_attach/draft_detach handle attaching attachments to the message and
  detaching them again, respectively.
- draft_discard handles removing a draft.  We have an explicit task for this
  because deletion got nebulous as soon as gmail entered the picture, and
  because drafts-on-server potentially benefits from this being very explicit.
- outbox_send handles moving a draft to the outbox and sending it as well as
  aborting the send process by moving the message back to be a draft.  As
  discussed above, pending sends are tracked as complex state rather than simply
  being present in a folder, so this needs to be a single task.

### Global Tasks versus Per-Account Tasks ###

While most of the logic for these tasks exists in the global tasks directory,
we register them as per-account tasks.  Although it's not critical, we do this
because the draft objects themselves are stored in account storage, so the
tasks don't make sense without the account and we want to reap the tasks when
we reap the account.

Notably this means that draft_create is a global task.  Although it will save
the task into account-specific storage, the potential for heuristics that figure
out what account to use and the like means we may not actually know the account
we'll store the draft into until we actually "plan" the task (which is also its
terminal stage).

In the future when we allow drafts to change their sending identity which
can result in a change of storage location, that task will still be per-account
since the draft we want to move is still bound to an account.

#### draft_upload ####

draft_upload will be a complex task whose state tracks the set of local drafts
which are dirty with respect to the server and need to be updated.

Draft uploads are intended to be atomic removals of any prior version of the
draft with replacement of the new state.  When REPLACE is available, it will be
used, but in the meantime, APPEND followed by deletion/expunge is the plan for
IMAP.

A local draft's state as it relates to uploads is one of the following:
- local-only: The draft only exists locally.
- synchronized: The draft exists locally and on the server with the same state.
- stale-server: The draft exists on the server but it's stale, the most recent
  state exists only locally.

You can think of there existing a notional state "local-stale" where the server
has the most recent data and our local data is stale.  However, because messages
are immutable for low-level sync purposes, our sync logic will interpret this
situation as a "synchronized" message being deleted and remove our draft.
Coincidentally, an entirely new draft may also happen to show up which humans
know is the successor to that draft, but which the sync process views as
completely new and different.

When a draft transitions from "synchronized" to "stale-server" we want it to be
impossible for the synchronization logic to delete that draft.  This can be
accomplished by breaking the umidName mapping used by the synchronization logic
or by making the deletion logic in sync_conv capable of ignoring the deletion.
Sync logic is resilient to umidNames no longer existing, so that works and
avoids complexity-inducing cross-task consultations, but it does create a
potential race where the name can be resolved and the deletion issued around the
time the draft is being saved.  However, such a scenario is already somewhat
byzantine in nature and is hard to fight.  Our best option is to have active
composition contexts endeavor to keep themselves in a "stale-server" state as
much as possible while active.

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

### The naming/id problem ###

The server name for a draft changes each time we save it since we must create a
new message-id header and a new UID will be allocated.

We want our UI to be able to main stability despite the underlying identifier
changes as the user saves drafts as they type.  This most significantly impacts
the current prototype react.js quasi-functional flow where MessageComposition
instances are hung off of MailMessage instances.  In this case, two things are
critical:

- We need the MailMessage to maintain its object identity / instance.  It can't
  be instantaneously nuked and re-recreated.
- We need there to not be a vulnerability window where the draft has the server
  id "oldServerId", we issue a save, and then the draft has server id
  "newServerId" and there's a time window where the front-end knows
  "oldServerId" but the front-end only knows "newServerId".

An exploration of our options, skip this if you don't care about what was
considered:

- Create a stable id, dealt with at some consistent abstraction boundary:
  - The ListView implementations could be aware of magic "stableId" values that,
    if present, should key the object such that in a single batch an object
    instance can be deleted from one id and re-created with a new id and have
    the instance make the jump.  This avoids contaminating the backend with
    persistence concerns, but doesn't address the vulnerability window.
  - Deal with this at the sync boundary; the back-end only ever sees the stable
    id, and the sync logic just has the idea of a bounded-size alias table for
    the finite number of messages falling into this case.

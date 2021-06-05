## Phabricator Schema

Types:
- DREV: Revision.  The review.  Always has a current diff `diffPHID` and holds
  metadata about the reviewers.  Comments and changes to the review are tracked
  as transactions against the revision (`PHID-XACT-DREV-*`).
- DIFF: The specific commits that are being reviewed.  Includes tree-related
  info and the commit message.
- USER: Humans (or specific robots).
- APPS: Phabricator internal mechanisms or robots?  Ex:
  "PHID-APPS-PhabricatorHarbormasterApplication",
  "PHID-APPS-PhabricatorHeraldApplication" both show up as authors of
  transactions.
- PROJ: Groups like review groups.
- PLCY: Policy, most relevantly used to define who can modify the group list,
  this is usually a policy that says administrators and the group members.

## Sync Strategy

General:
- Maintain a set of potentially overlapping query constraints, each of which
  has an associated highest `dateModified` perceived.
  - The "sync_refresh" task runs these queries in (conceptually) parallel,
    using `modifiedStart` to ensure we only hear about things that have changed.
    - We'll also use an initial "order" of "updated" until paging logic is
      activated.
- The DREVs we hear about are unified into a Map and "sync_drev" tasks generated
  for each drev, providing the per-drev info obtained from those queries.
- The "sync_drev" tasks:
  - If there is no already processed `diffPHID` or it changed, fetch it.
  - Run a `transaction.search` on the DREV using `dateModified`.  (Comments can
    be edited, which will result in `dateCreated` and `dateModified` differing.)

Expected query constraints:
- Default:
  - "responsiblePHIDs": [USER_PHID]
    - This should cover all reviews directly asked of the user or groups they
      belong to.

### Identifiers ###

Objects have a short server-specific integer `id`s (that may be namespaced by
the `type`?) in addition to a string `phid` that bakes in the type that's
clearly intended to be more of a GUID.  Because the `id` is shorter and
sufficiently unique, we use that as the basis for our conversation (DREV) and
message (XACT-DREV) identifiers.

Our specific id mappings:
- Conversation id: "account id.drev id"
- MessageId: "account.drev id.transaction id.0".  We tack a 0 on the end for
  consistency with what we've already done for email clients, but we might be
  able to moot it.
- UniqueMessageId: This is the "PHID-XACT-DREV-..." phid.
- guid: null, not relevant unless we actually want to use this to store the
  guid of the corresponding phabricator mail generated by this?

### Dynamic Folders / Labels ###

We want to be able to categorize revisions using dynamic labels that can be used
like folders (gmail style).  We inherently don't know what folders make sense
for a revision before we attempt to sync it.  This poses a new problem for
gelam; all email accounts would traditionally have explicit folder creation
steps as orthogonal tasks to sync.  Things are somewhat simplified by the
original implementation decision to always have the list of folders in memory
at all times, as this simplifies the issue of authoritative state.

The available strategies to deal with this are, by family:
- Have an explicit task for idempotently creating/ensuring folders.
  - If a sync task wants a folder that doesn't exist, schedule a folder creation
    task and mark it as a dependency and cause our task to need to be
    retriggered.  This should converge although one can imagine a number of
    races where the next attempt to sync now sees additional state that merits
    new folders, but a pathological situation is unlikely.  This increases
    conceptual complexity but the expected steady state is straightforward and
    doesn't pay a price for every revision sync.
  - Break the sync_drev task into multiple tasks.  The initial task's
    execution would do enough to figure out all the folders needed, then beget
    any folder creation as a task, plus the actual conversation churn task.
    This feels less hacky than the above but feels like it's worse structuring
    because we're multiplying actors for a reason that doesn't actually line up
    with the data or its processing, but instead is an outgrowth of transaction
    limitations.
- Use the subtask mechanism.  There's a means of spawning a subtask, but the
  subtask isn't subject to any scheduling resources.  It's really about database
  writes and write-locks.  All resources need to have already been reserved by
  the spawning task, but we don't want the theoretically parallelizable
  sync_drev tasks to be blocking each other all the time.  The subtask mechanism
  could be extended but that seems like creating a (bigger) footgun.
- Create a centralizing daemon for allocating new folder id's.  We already have
  the folders all in memory, so it's straightforward to synchronously locate
  an existing folder or, if it doesn't exist, allocate a new id and put it in
  the lookup table so it can't be duplicated.
  - Unfortunately we potentially run into a coordination / atomicity issue when
    trying to parallelize.  If we have two tasks that both want to create the
    same new folder that are running at the same time, we want the first one
    that writes to disk to write the folder with it.
    - This may be something that can be handled via the database trigger
      mechanism.  It provides a mechanism for code to run during finishTask and
      add more manipulations to occur. STOPPED HERE.  **USE DB TRIGGERS**

### DB: syncStates ###

A single sync record containing:
- A map from the query definitions to:
  - `lastDateModified`: The most recent `dateModified` observed.
  - `firstDateModified`: The start of our synchronization time window.  Any
    revisions with a `dateModified` chronologically prior to `firstDateModified`
    pre-dates our concern.


#### Thought Process

- For sync purposes we can view each revision as a tuple of (phid, dateModified)
  where we need to sync the revision if the phid is new to us or the
  dateModified has increased.
- Assuming that the dateModified timestamps are monotonically increasing,
  Phabricator reliably updates the timestamps whenever interesting things
  happen or change on a revision, and Phabricator is sufficiently consistent, it
  is sufficient to remember the highest `dateModified` seen in the last sync for
  the given query.
  - The primary concern is that there is a window of time for which results may
    be inconsistent, such as when additional values with the same "dateModified"
    as the most recent "dateModified" could still show up (or values from before
    that).  Assuming there's a way to determine the current wall clock of the
    phabricator server, the dateModified could be backdated to whatever is less,
    the current wall clock less uncertainty period OR the highest dateModified.

### task: sync_refresh ###
- Request `differential.revision.search` with order="updated"
  tells us about new and changed revisions of interest, with `dateModified`
  allowing us to determine when we've processed to our last stopping point.
  - A constraint of `modifiedStart` set to the given `lastDateModified` should
    provide only new changes.
    - For the first sync we can arbitrarily pick a date roughly a week ago
      (or whatever) and set that to the `firstDateModified` and
      `lastDateModified`.
  - By not specifying queryKey="active" this should hopefully help provide
    closure for completed revisions, but it might be appopriate to do a
    follow-up `differential.revision.search` on previously known id's that
    didn't show up in the above results to clear them out if we increase
    filtering.
- Generate "sync_drev" tasks

### task: sync_grow ###

The goal here is to expand `firstDateModified` further back into time.

- Request `differential.revision.search` with order="updated" and
  constraints:
  - `modifiedEnd`: This should correspond to the current `firstDateModified`
  - `modifiedStart`: This should correspond to the desired (further back in
    time) `firstDateModified`.

### task: sync_drev ###

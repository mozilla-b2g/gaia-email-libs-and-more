Vanilla IMAP sync: a mash-up of the v2 refresh-only sync algorithm and gloda's
conversation logic assuming only RFC3501 capabilities (if that, grrr.)

## Overview ##

### Sync Strategy ###

For each folder we maintain a time-range for which we believe ourselves to be
up-to-date.  We also allow for the possibility of us being aware of messages
not covered by this time range but that we are aware of because of conversation
backfilling or because

In the pre-conversations era we tried to be clever and efficient and deal with
these time ranges in smaller bites, allowing us to keep our refresh logic scoped
to just what the user could see or would soon see.  However, with conversations,
our access to messages becomes inherently random access and so stale information
becomes a potentially huge problem.  As such, we are compelled (and it's a lot
simpler) to just always refresh all the messages we know about in a folder when
refreshing a folder.

Bandwidth use mitigation can be achieved by making sure to winnow the messages
we know about more aggressively.  Churn waste where we forget about a message
but then find ourselves re-synchronizing it again soon could be avoided by
moving messages into a "limbo" state with an eviction policy rather than
immediately purging them.

Because we still care about fetching new messages efficiently, we are sure to do
that step first, then we refresh what we know about.  Additionally, as a change
from our previous purely date-based sync algorithm, sync_refresh now just does
UIDNEXT based detection of new messages.  sync_grow, which also handles the base
case, is the only one that cares about date-ranges.

### Sync Growing Strategy ###

When the user wants to see more messages in a vanilla IMAP server, our goal is
to grow the synced time range by an amount that gives us a reasonable amount of
messages.  Not too many, not too few.

Pre-convoy our heuristics were:
1. See if the number of messages in this folder that we don't know about is
   small.  If it is, just sync them all by moving our date window all the way
   back to our oldest sync date, 1990.
2. Too many messages, eh?  Well then, let's pick a time window covering a small
   number of days.  Did we get too many?  Let's shrink the window and try again.
   Did we not get any?  Let's grow the window and try again.  If we got some,
   process them, but then also try again if we still don't have as many messages
   as we want.

It should be noted that the latter approach was really just our initial attempt
that sort of got stuck in time.  It was naive in terms of assuming it was
possible for us to save the server from the horrors of sequence numbers.  That's
not something we can save servers from.

In convoy, we still have the first heuristic, but we've modified the second one
to instead be informed by the actual dates of messages in the folder.  The
basic idea is that most of the time, the messages in the folder will have a
strong correlation such that as the message sequence number and UID increase,
the date associated with messages will increase too.  This will not always be
true, and when it's not true, it will be catastrophically not true.

Our approach is to issue a FETCH for message INTERNALDATEs using some
statistical sampling.  Our goals are to:
1. Try and pick a good date for us to use for growing, assuming that the
   correlation holds true.
2. Try and sample enough message dates spread throughout the folder so that we
   can ensure that the correlation does hold true.  Note that we don't need to
   figure out the actual distribution of message, just validate our assumption.

In the event our assumption is not validated, we fall back to advancing
backwards into time using a fixed window.  We do not do any adaptive growing,
etc.  There is definitely future work here, but this is a huuuuuge improvement
over the iterative deepening strategy we used previously.

Please see ../task_mixins/imap_mix_probe_for_date.js for the implementation
nitty-gritty and all the important hand-waving we do.

### Conversation Mapping ###

Vanilla IMAP servers by definition have no awareness of conversations.  They may
have THREAD support (rfc5256), but that only matters to our backfilling logic.
Accordingly, we must allocate conversation id's ourselves and we do so initially
using the strict references/in-reply-to logic gloda uses.  However, we also
intend to leave the door open for more clever approaches that blend subject
and content analysis.  If only to compensate for Mozilla mailing list/newsgroup
gateway snafus where strict threading breaks down horribly.

The other main issue we contend with is duplicate messages.  This is not the
Gmail IMAP mapping issue (gmail has its own sync engine, avoiding that), but
cases like:
- The user sends a message to a mailing list and ends up with the original copy
  in the sent folder (sans mailing list footer/transformations/etc.), plus the
  copy received from the mailing list.
- Multi-path phenomenon where someone sends a message to mailing lists spread
  across multiple-servers and/or where the user is also directly listed as a
  recipient and/or where the mailing list server does not have duplicate
  suppression set-up and/or where aliases used by the user preclude
  de-duplication.
- In the future, if we consolidate conversations across accounts, this could
  happen even more.  However, we are not dealing with that anytime soon.

The back-end currently does nothing to address these scenarios because any
solution is likely to be complex and require even more complexity to allow UI
manipulation of the messages underlying the aggregate.  (And could be very
confusing to the user.)  For now it seems best to leave it up to the app/UI to
address, such as collapsing duplicate messages by default or hiding them.  The
back-end could provide some support for automatically hiding the messages by
using a filtering mechanism, eventually.


## Implementation ##

### Naming and Indirection ###

We allocate our own identifiers for conversations and messages.  We call them
uniqueMessageId's.  We name them this because we can then abbreviate them as
"umid" which sounds like "humid", and given how many things we have that involve
the nebulous concept of "message id", we need all the humor we can get.  (Plus
I can claim it's like a mnemonic.)

We do this because:
- message-id header values are not guaranteed to be unique.  They're also
  pretty long and unwieldy.
- UIDs tupled with the folderId are fine up until you contend with offline
  message moves.  Then you end up needing to provide your own identifier and/or
  deal with complicated renaming transforms.  This really complicated the v1
  job-op infrastructure.

For now, uniqueMessageId's look like a folderId with an additional number
suffixed onto them.  But the inclusion of the folderId is just to simplify the
unique allocation of the id's.  The folderId component of the uniqueMessageId
has no meaning after the id is allocated; the payload in the umidMap table is
the actual location of the message.

### Efficient Flag Updates ###

Without CONDSTORE/QRESYNC, the only way to tell if a message has had its flags
change is by knowing what they were before and checking if they changed.  In v1
the sync logic had all the headers of the messages being refreshed already in
memory, which made this relatively easy.  For conversations we add a layer of
indirection and don't want them in memory.  It would be wasteful to store all of
the flags for all the messages verbatim in memory, but there is much redundancy
in the set of flags applied on each message, and we can leverage that.

The current lazy plan is, with safe escaping, to sort the flags and then encode
them in a string.  We maintain a list of those strings, and the index of the
string in the table is the value we associated with the uid.  When we fetch the
flags we compute the new table position, and easily observe any deltas.  We
maintain reference counts in a parallel list and null out unused values.

### Database Usage ###

- syncStates: A per-folder object is maintained (namespaced by accountId).
- headerIdMap: Keys are message-id header valuess namespaced by accountId and
  each value is either a conversationId or a list of messageId's.
  It's a conversationId if we don't have the message yet, list of messageId's if
  we do.  (There could be duplicates.)
- umidLocationMap: Keys are unique-message-id's allocated as new messages are
  found.  Values are the current folderId and UID of the message in that folder.
  Together with umidNameMap, this provides consistent naming (the umid) for
  IMAP manipulations despite the potential for message moves (impacts folderId
  and UID) and local message renaming due to conversation merges.  (Which suck
  but can happen.)
- umidNameMap: Keys are uniqueMessageId's allocated as new messages are found.
  Values are the full messageId with conversationId prefix.
- convInfo: (the standard)
- messages: The standard, but with the message also including its umid.  When
  tasks with online components are planned, they will identify the message by
  its umid.  This allows tasks like flag changes to be orthogonal to move
  operations

### The Sync New Message Cascade ###

- sync_refresh: Folder-sync notices a new UID that satisfies our date
  constraints.  It allocates a new unique message identifier (umid) allocated by
  us and enqueues sync_message jobs with the date attached for prioritization
  purposes.
- sync_message(1): The message envelope is fetched, including its message-id,
  references, and in-reply-to headers.  A query is made in the `headerIdMap`
  table for all of these values.
  - If no matches are found, a new conversation is declared and the umid is
    reused as the conversation part of the conversationId.  (This is arbitrary
    but sorta consistent with how gmail works).  We continue.
  - If matches are found identifying at most a single conversationId, the
    conversationId is used and we continue.
  - If matches are found identifying multiple conversationId's, a merge is
    required.  We arbitrarily pick a conversationId (the rootiest one?), put a
    sync_merge task in our spinoff-task list that will run a merge against all
    impacted messages, and then continue.
  - Note that in the case of duplicate messages, it's possible for there to
    already be a message with this messageId.  We could be smarter about
    detecting moves in the future in this case.  But for now we just sorta are
    shoddy.
- sync_message(2): The conversation and its already-existing messages are loaded
  and the churn function is run.  The conversation and message are written to
  the database, and headerIdMap and umidMap are appropriately updated.

### The Sync Refresh Flag-Change Cascade ###

The only changes we can see for messages are flag changes.  As noted above, we
do clever things to only generate tasks when flags actually change.

- sync_refresh: We do a UID SEARCH UID {UIDs we know about} in order to infer
  deletion.
- sync_refresh: We notice the UIDs with flag changes.  From this we know the
  umid's.  We do a batch read of these umid's from the name map to get their
  message id's so that we can bin them by conversation.  We generate sync_conv
  tasks where we provide the updated flags to the sync_conv task.
- sync_conv: Loads all of its messages, applies the flag changes to the impacted
  messages, runs its churn, and saves back the updated conversation and
  messages.

### Merges ###

Conversation merges happen automatically as a result of messages that only
provide in-reply-to headers so we only know the message directly replied to.  Or
clients that otherwise truncate the references headers.  In the future merges
might also be triggered by explicit user action or as a result of a follow-on
daemon process that is sufficiently expensive that it can't run as part of the
main sync logic.

The sync_merge task takes a list of message-id headers that are all believed to
belong to the same conversation.  It issues a request against `headerIdMap`,
gathers all the results, then arbitrarily picks the new consolidated
conversationId.  It transforms the messageId's of the impacted messages,
resulting in database changes:
- The now-merged conversations and their messages appear to be deleted.
- The now-merged messages appear newly added to the target conversation.
- The headerIdMap entries get updated
- The umidMap entries get updated

### Compensating for moves by other clients ###

As noted in the sync cascade, when we see a new message, it's possible for us
to realize that we basically already know about this message.  But we don't do
that right now.

## Code Reuse with POP3 ##

Although POP3 sync is absolutely dissimilar, we are able to reuse the bulk of
our conversation logic by creating mixins that both we and POP3 reuse.
ActiveSync would reuse this too if we could actually get references/in-reply-to
headers for messages.

## Other Operations ##

### Moves ###

The planning operation is straightforward: we just update the folderId location
of the message.

We do implement this as a complex task with the marker keyed by the umid so that
even if a user goes crazy moving a message between folders while offline, we
only ever track the intended final folder for it to live in.  However, we don't
implement any batching for initial simplicity reasons and the knowledge that
this will be sufficiently rare enough and to isolate failures.

So the execute step knows the umid of the source message and the desired target
folderId.  We read the umidMap entry for the umid to determine its current
location, go in that folder, then perform the move, and get the new UID back.
We also load the sync state for the source and target folders and update their
uid/umid and maps.

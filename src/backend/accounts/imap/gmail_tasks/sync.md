## Gmail-specific Concepts and Strategies ##

### "All Mail" all the time, UIDs 4evah ###

"All Mail" has the magically delicious property that all messages that aren't
trash or spam are in there.  This makes it the best (only?) way to find all the
messages that are in a conversation.  It also means that the UIDs in the all
mail folder are eternal (for all intents and purposes).

Because this is arguably handy, we bake a message's all mail UID into the SUID.

### Folders are just pre-filtered views of "All Mail", so forget folders ###

Gmail's SEARCH implementation supports searching using "X-GM-LABELS" as a
predicate to get the equivalent (from our perspective) of performing the search
in a folder.  (Note that it's conceivable we may be imposing a greater cost
on Gmail, depending on how their IMAP backend is implemented and optimized.)

To this end we only ever do synchronization in "All Mail".  HOWEVER, when we
are doing sync_grow to grow our synchronized time period for a label/folder,
we do enter the folder because it lets us do sequence number tricks that are
not something we could do as efficiently in All Mail.  (Because in order to
get a similar view in all mail, we would have to issue a SEARCH over the entire
folder.  While it's possible gmail could cache this the same way it's compelled
to build and cache the sequence number tables for folders, we would not get
the same "address space" as we do by entering the folder.  Specifically,
the message sequence numbers in the "foo" folder will continuously cover
[1, EXISTS] whereas in All Mail both UIDs and sequence numbers would be sparse
and so we'd have to hear them all from SEARCH.)  Please see the vanilla imap
sync.md's description of growing and ../task_mixins/imap_mix_probe_for_date.js
for more informatio.

For CONDSTORE steady-state things are somewhat trickier but CONDSTORE is
powerful enough that we can pick trade-offs that still work out quite well for
us.  The main limitation is it won't tell us what got deleted and so we need to
infer that by noticing the UID is no longer there.  But since people rarely
delete things on gmail, by doing our sync in All Mail we largely are able to
reduce the importance of the deletion inference since the likely thing is that
it'll just cease to have any labels we care about.

## Sync ##

### What to sync ###

Given a set of labels yayLabels and an overall date range yayRange that we care
about (where yayRange is the max() of the per-yayLabel yayRanges we care about)
there is a set of maybeYayMessages that are of potential interest to us.  Once
we apply the more thorough per-label yayRange logic, we end up with the actual
yayMessages.  The (de-duplicated) set of conversations that these messages
belong to constitute our yayConversations.  The messages that belong to these
conversations are our careMessages.  Messages in careMessages but not in
yayMessages are mehMessages.

Once a message is no longer in careMessages then we no longer want it in our
storage and it belongs to mootMessages.  Inherently its conversation must also
be in mootConversations.

### CONDSTORE steady-state case analysis ###

In the abstract, when CONDSTORE knows something has changed on a message, there
are a number of things that could be happening, and those could mean different
things to us.  Note that we're ignoring mootMessages for this analysis.
- It's an entirely new (to us) message, this is known by having a UID higher
  than the highest UID the last time we were in this folder. We might care about
  it if:
  - It has a yayLabel for which its date is in the yayRange.  This is feasible
    to use search to filter on because the set of yayLabels is small and our
    overall yayRange is likewise concise.
    - If the message introduces a new yayConversation we need to trigger a
      specific sync pass on that conversation.  That will find us all the
      careMessages.  This is unavoidable.
    - If the message is part of an existing yayConversation we don't need to do
      anything particularly special.
  - It belongs to a yayConversation and is therefore a careMessage.  This is not
    particularly feasible to use search to filter on because the set of
    yayConversations is large and it seems likely the IMAP implementation might
    get angry if we do this.  (Certainly it's not likely to be a particularly
    supported code path.)  However, since we can filter on new messages based on
    the UID range we can minimize the bandwidth used by limiting the FETCH to
    the conversation ids of the messages in question.
- It's an existing message and:
  - It's something we have synchronized before (could be yayMessage or
    careMessage):
    - It might have become irrelevant by having been a yayMessage, having
      labels removed, and now no longer meeting any yayLabels.  (Note that
      yayRanges cannot change as a result of sync.)  Unfortunately, although
      CONDSTORE does define a MODSEQ Search Criterion that could potentially
      be used to help filter, it's optional and only allows filtering on a
      single thing, so it's useless for our purposes.  SEARCH also can't detect
      the "falling edge" of ceasing to be a yayMessage which means we need to
      FETCH all the changed messages' relevant features to be able to tell if
      they are yay or not.  If it did become irrelevant, we need to figure out
      if this makes its conversation no longer yay.  Options are to have
      yayConversations maintain a count (or explicitly name its yayMsgs), or to
      enqueue a task that can lookup the information and make the determination.

  - It's something we have NOT synchronized before (AKA not in careMessages):
    - It might have become relevant (and a yayMessage) by now matching yayLabels
      appropriately.  Since it wasn't a careMessage, the conversation must not
      have been a yayConversation and we could theoretically avoid that check.
      But since multiple messages in the same conversation could have made this
      transition we still need to perform a set check (or depend on some other,
      potentially more expensive suppression mechanism like tasks).

For deletion inference,

### CONDSTORE new versus changed ###

If we crunch all the bullet points from the steady-state case analysis we can
determine that unfortunately we need to consume the entire FETCH CHANGEDSINCE
stream.  The only real question is whether there's an advantage to doing a
separate query for new UIDs versus UIDs in the known range.

The main thing distinguishing them is that new UIDs are inherently messages that
we have not synchronized and if they end up as careMessages, we need to fetch
their envelopes which means we will be issuing a FETCH against them in the
future.  Whereas for known UIDs it's possible we've already synced the message
and it's just the mutable metadata that we care about.  In fact, if we haven't
already synced the message, we know that it's part of a new yayConversation and
so a converation sync process and therefore an additional FETCH must happen.

Needs:
- fundamental: UID
- yay determination
  - new: X-GM-LABELS, INTERNALDATE
  - changed: X-GM-LABELS, INTERNALDATE
- interesting mutable bits
  - new: don't care, the header/envelope needs to be fetched
  - changed: X-GM-LABELS, Flags
- sync prioritization: X-GM-LABELS (sync what the user's looking at first),
  INTERNALDATE (for ordering)
- data for syncing new yayConversations:
  - new: X-GM-THRID
  - changed: X-GM-THRID

Things we sorta don't need to care about:
- X-GM-MSGID: the uid is good enough for most of our purposes, and we can pick
  it up when fetching the envelope since it's immutable.

So the difference ends up being that for changed messages we care about the
flags.  Which is a savings.


### Scalability through Sets ###

By structuring our various logic pieces as sets/maps that we perform
intersections against, our logic can be adapted to a streaming/chunked
implementation.  We're not doing that now, though.  Our main goal is to simply
keep our in-memory sets small enough and the bulk of our processing as
reasonably sized batches so our working memory needs are always reasonably
bounded.

### Pseudocode of steady-state ###


(Note that nextyuid is the UIDNEXT from when we last synchronized.  Not the
current UIDNEXT.)
```
newMsgs = UID FETCH nextyuid:* (UID INTERNALDATE X-GM-LABELS X-GMTHRID)
changedMsgs = UID FETCH 1:nextyuid-1 (UID INTERNALDATE X-GM-LABELS X-GMTHRID FLAGS)

newYayMsgs, newNonYayMsgs = yayFilterMessages(newMsgs)
changedYayMsgs, ignoredNonYayMsgs = yayFilterMessages(changedMsgs)

newMehMsgs, ignoredNonMehMsgs = filterMessagesOnYayConversations(newNonYayMsgs)

yayConvsWithDates = uniqueifyConvsTrackingHighDate(newYayMsgs, changedYayMsgs)
newYayConvsWithDates, ignoredExistingYayConvs = yayConvsWithDates - knownConvs

// Conversations that are entirely new get synchronized.  (And there is no point
// in scoping the conversation to specific UIDs since we may not know all the
// UIDs of messages in the conversation.)
scheduleForAll(newYayConvsWithDates, sync_conv)

// New messages for existing conversations use sync_conv too, but as an
// optimization we can tell sync_conv what their UIDs are.  (Inductively, we
// must already know all there is to know apart from these new changes.)
scheduleForAll(newYayMsgsInKnownConvs, sync_conv)

// XXX messages that are no longer yay.  see above

// existing messages get their metadata updated
// note that the task is potentially non-trivial since we will also want to
// apply any currently un-applied tag states (to avoid sync races), and this is
// potentially a place we might let extensions dig into.
changedCareMsgs = intersectKeepingData(changedMsgs, knownCareMsgs)
scheduleForAll(changedCarMsgs, update_metadata)
```

### The ordering of "grow" and "refresh" as it relates to MODSEQs ###

The primary risk with MODSEQs is that we switch to a more recent MODSEQ without
having processed all of the state for the older MODSEQ and then miss out on data
and potentially never re-synchronize.

This is not a problem for us because we know that only the "refresh" operation
meaningfully consumes these changes, so "grow" cannot and should not impact the
MODSEQ of "refresh".  This means that we can perform a "grow" whenever we want.
The primary efficiency risk is that "grow" performed before "refresh" may result
in the "refresh" redundantly updating flags/labels.  This is acceptable.  (And
could be mitigated by storing the MODSEQ in sync state, but that's a lot of
overhead and we know from the IMAP list that right now Gmail has bugs with
MODSEQ where this optimization might result in us not actually having the
up-to-date state due to MODSEQs not actually being distinct.)

The one important exception is that in the initial "grow" case, we can and
should use the MODSEQ from our initial query as the MODSEQ that "refresh" should
use for the first refresh.

## Optimizing Time-to-Conversation-List ##

When we synchronize our Inbox for the first time, our goal is to fetch enough of
the newest conversations' summaries to display to the user.  Where we the server
does not provide precomputed snippets (fastmail does via ANNOTATE, gmail does
not), this means subjects.  Subsequently we want snippets, specifically the
snippet that will get used in the conversation summary, and we want to
prioritize this across all conversations with the other snippets only being
fetched once these are satisfied.

### Example Task Scheduling ###

"sync_folder_grow:inbox" is scheduled and runs, locates 4 messages: [msgA/conv1,
msgB/conv2, msgC/conv1, msgD/conv3].  This results in a conv ordering of
[conv1, conv2, conv3] (oddly convenient!).

The task schedules "sync_conv:conv1", "sync_conv:conv2", and "sync_conv:conv3".
Although we have some information on the conversations at this point, it's not
enough to admit to the front-end that the conversations exist.  Accordingly we
grant these sync tasks the priority of the view slice looking at the folder as
a whole rather than based on specific conversation id's being part of the focal
area of the view slice.

## Implementation Details ##

### Sync State ###

The object has the following fields:
- modseq: The modseq the next "refresh" should start from
- labelSinceDates: A map:
  - keys: FolderId's for the folder that corresponds to the label in question.
  - values: The UTC Date we used as a SINCE to get the data we have now.  If you
    want to synchronize new data, you want to use "BEFORE" with this date and
    then "SINCE" on some date at least one date prior to this one.
-

### SUIDs ###

Gmail message suids contain [AccountId, GmailMsgId, AllMailUID], smooshed into
a string with each part joined by '.' as is our tradition.

In the event a message is in trash/spam, we will probably put special sentinel
values in the place of the AllMailUID that couldn't be mistaken for an
AllMailUID.

## Gmail IMAP Notes ##

### Labels ###

Labels are stored per-message even though the Gmail web UI's conversation view
makes it seem like labels are per-conversation only.

You can create a new label by manipulating X-GM-LABELS; you do not need to
CREATE it as a folder.

??? What does the gmail ui do message/conversation-wise versus labels.  Like if
we set a label on a conversation, does it label them all?  Likewise, what's the
deal with \\Flagged and the starred folder?

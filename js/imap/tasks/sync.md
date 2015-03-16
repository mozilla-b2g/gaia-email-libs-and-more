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

## "All Mail" all the time, UIDs 4evah ##

"All Mail" has the magically delicious property that all messages that aren't
trash or spam are in there.  This makes it the best (only?) way to find all the
messages that are in a conversation.  It also means that the UIDs in the all
mail folder are eternal (for all intents and purposes).

Because this is super-handy, we bake a message's all mail UID into the SUID.

### SUIDs ###

Gmail message suids contain [AccountId, GmailMsgId, AllMailUID], smooshed into
a string with each part joined by '.' as is our tradition.

In the event a message is in trash/spam, we will probably put special sentinel
values in the place of the AllMailUID that couldn't be mistaken for an
AllMailUID.

## Gmail IMAP Notes ##

Labels are stored per-message even though the Gmail web UI's conversation view
makes it seem like labels are per-conversation only.

You can create a new label by manipulating X-GM-LABELS; you do not need to
CREATE it as a folder.

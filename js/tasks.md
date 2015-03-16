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

The great and powerful MailDB database!

## Responsibilities ##

Responsible for:
- Caching (someday).  We don't cache now.  Consumer code should *not* grow
  caching logic.
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
that data attributed to your task.  You ask for all mutation requests at the
same time in your task, thereby ensuring a consistent locking discipline.  (If
any request is against something with an already-held mutation lock, you wait
for that task to complete and a serious warning is generated since this
likely constitutes a bug that needs to be addressed with additional task
constraints or more significant implementation change.)

When data is retrieved for mutation purposes, if we maintain any index-like
tables for the record, we will snapshot them so that we can do any delta
inference when you complete the write process.

If the task is aborted, all resources associated with the task are released
without changes.


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

Here are the events we generated organized by data type.  Concatenate the
various pieces of the hierarchy to get the true event.

- `accounts`:
  - `!added` (account): A new account!
  - `!changed` (account): An account changed
  - `!removed` (account): An account was removed
- `acct!AccountId`: per-account
  - `!changed` (account): The account was changed
  - `!removed` (account): The account was removed
  - `!folders`: Stuff for the account's folders
    - `!added` (folderMeta)
    - `!changed` (folderMeta)
    - `!removed` (folderMeta)
- `fldr!FolderId` folder info
  - `!changed` (folderMeta): The folder's record changed
  - `!removed` (folderMeta): The folder's record was deleted
  - `!convs`: Something happened with the set of conversations in the folder
    - `!added` (convInfo):
    - `!changed` (convInfo, whatChanged: { date }):
    - `!removed` (convInfo)
- `conv!ConvSuid` per-conversation
  - `!changed` (convInfo)
  - `!removed` (convInfo)
  - `!messages`:
    - `!added` (headerInfo)
    - `!changed` (headerInfo)
    - `!removed` (headerInfo)
- `msg!MsgSuid` message header
  - `!changed` (headerInfo)
  - `!removed` (headerInfo)
- `body!MsgSuid` message body
  - `!changed` (bodyInfo, whatChange)
  - `!removed`
- `tach!MsgSuid:AttId` message attachment

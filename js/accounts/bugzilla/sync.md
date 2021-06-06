## Sync

### Search Queries

The REST API's search functionality documented at
https://bmo.readthedocs.io/en/latest/api/core/v1/bug.html#search-bugs is
somewhat limited, but through its support of the "quicksearch" syntax it ends
up being very powerful.  When combined with `last_change_time`, this allows for
the general criteria we need.

https://bugzilla.mozilla.org/page.cgi?id=quicksearch.html documents the BMO
quicksearch mechanisms supported (many of which are BMO specific).  The
constraints of note to us are:
- `ALL` as a prefix so we see closed bugs too.
- `assignee`
- `cc`
- `reporter`
- `commenter`
- `needinfo?USER`: From the advanced shortcuts mechaism for flags, this searches
  for USER as the requestee.
- `requestee`: Is the requestee of a flag.
- `setter`: Is the requester of a flag.
- `flag`: Has the given flag set (which I guess the +/-/? gets integrated if
   elaborated upon.)
- `component`
- `product`

Because this supports `OR` we can arrive at the following general query (that
wants to be time constrained):
`ALL assignee:USER OR cc:USER OR reporter:USER OR requestee:USER OR setter:USER`

This gets us most activity but misses drive-by commenting where the user isn't
CC'ed.  This is an intentional decision since it's usually an intentional choice
to not be CC'ed on a bug in those cases.

This would want to also be complemented by a component watching system and/or
other-user-watching system.  Perhaps even directly driven by received bugmail
so that watches are automatically translated.

### Task Structure

#### sync_refresh

Issue a time-constrained quicksearch query as described in the previous section
that's time constrained based on the highest "last_change_time".  The
included_fields request is just "id" and "last_changed_time".

### sync_grow

There's no optional counterpart to "last_changed_time" to create a window that
stops before "now".  So a grow sync that extends the "first" time further back
into time ends up being a modified version of sync_refresh where we pick a
"last_changed_time" that is our "first" time less our growth window.  We then
just ignore any bugs that have a "last_changed_time" more recent than the
pre-growth "first" time.  Anything that is more recent than that has inductively
already been synced (or has had a sync task created at least).

### sync_bug

The [bug API](https://bmo.readthedocs.io/en/latest/api/core/v1/bug.html)
can directly return attachments, comments, and history or they can be separately
retrieved.  If separately retrieved, comments and history support a `new_since`
predicate that allows only retrieving new/unknown comments/history.

For now, we choose to retrieve all the data directly from the bug and to not
worry about redundantly fetching already-known comments and history.  The
rationale is similar to phabricator: bugzilla(.mozilla.org) now allows comments
to be edited.  The REST API doesn't seem to expose edits at all, which makes
it necessary to fetch all old comments in case they've been edited.

### Message Mapping

User actions frequently take the form of some changes to the state of the bug
and a comment that accompanies those changes.  These are logged separately via
"history" and "comments", but these can be re-joined via the history `when` and
the comment `creation_time`.

The `chew_bug.js` `BugChewer` fuses history and comments into a single
linearized view which then form the basis for message generation for the
account.
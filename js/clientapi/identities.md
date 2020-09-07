## Context / History

The original model of contacts / people / identities stemmed from a world where:
- GELAM only supported email accounts
- The platform provided a mozContacts API that explicitly was intended to be a
  cross-app datastore and which was externally synchronized.
  - The API was also main-thread only.

Email addresses have the notable characteristics that:
- They're global identifiers.  Email is a federated system and there's no need
  for additional namespacing.
- Lifecycle/temporal management is a trainwreck.  In the event an email address
  gets reused by different people over time, there is no in-band mechanism for
  conveying that.  (The email provider likely has unique account identifiers,
  etc.)  Which means that this is usually not addressed and people have to make
  do.
- Automated emails and spam detection have shaked the ecosystem deeply.  These
  shape the use of the "From" and "Reply-To" headers.
  - "Reply-To" may be a single-use email address that only exists for per-email
    bounce detection.  Bounce emails frequently only provide in-band
    munged textual descriptions of the bounce, and using one-shot email
    addresses helps simplify dealing with bounces/vacation auto-responders.
    Ex: Github notification emails.
  - "From" will usually attempt to be a stable identifier for the purposes of
    being allow-listed by the recipient's address book.  But this can also mean
    that the display name may include varying informational content that's
    distinct from the email address.  Ex: Github notification emails are "From"
    "notifications@github.com" but will have a display name of the github user's
    display name (not their "@" identifier).

Lessons learned from Thunderbird's Global Database "gloda" include (which
overlap strongly with NoSQL/modern best practices and even modern relational
best practices, at least pre-everything-is-SSD):
- Fully normalizing on email address accumulates garbage information in the
  database due to the existence of good single-shot emails (ex: github
  notifications) and nefarious spam emails.
- It's fine/smart to create on-demand indices and cached/saved searches.
  Computing an index over every piece of data before it's demonstrated that it's
  needed isn't necessary and often counterproductive.
- Most databases have a mechanism for efficient encoding of consecutively stored
  keys with key prefix overlap so one need not overly worry about medium length
  non-normalized key components.  (And in general a normalized representation
  which results in a marked increase in random access scattered reads isn't
  great even on SSDs.)

### Original Implementation

The database always stores a `{ name, address }` pair which gets wrapped into a
`MailPeep` instance that lazily populates additional `contactId` and
`_thumbnailBlob` data from the mozContacts lookup, also clobbering the name to
whatever the name of the contact is.

The notable thing here is that each message automatically has immediately usable
information for presentation.  The contact lookup could be thought of a form of
progressive enhancement that also happens to be very similar in nature to what
Thunderbird does.

## Plan

### Current

- NameAddressPair is { name, address } for display name and email address

### Phase 1

- Expand NameAddressPair dictionary along the lines of bugzilla's rep so we
  have:
  - name: Display name, always present (for mail accounts it's the email address
    if there was no explicit display name)
    - same as email
    - differs for Bugzilla where we get `real_name`.  "name" is present as
      a redundant version of the email address though for some reason that
      may have to do with magic sentinels or triage owners or something.
    - differs for Phabricator "user.search" where we get `realName`
  - address: Email address, not currently present for Phabricator
    - same as email
    - differs for bugzilla which uses "email"
    - not available for Phabricator's "user.search"
      - but is available as "primaryEmail" for "user.whoami"
  - nick: IRC/Matrix/Slack nick, always present for Phabricator
    - not an email thing
    - same as/from bugzilla
    - differs in Phabricator "user.search" where it is "username" (and oddly is
      "userName" in "user.whoami")
  - phid: Phabricator user PHID, specific to the account's server, always
    present for Phabricator
    - not an email thing, but we can transitively get from a PHID to a bugzilla
      numeric id to an email address
    - not a bugzilla thing, but we can bidirectionally move between the bugzilla
      numeric id and the PHID and from the numeric bugzilla
    - from phabricator
- For Phabricator syncing:
  - Introduce a ContactChewer mechanism that gets given to the Transaction
    Chewer that gets called to perform a mapping for PHIDs to the above
    dictionaries, handing out object dictionaries synchronously that will be
    mutated in place in a batch when the ContactChewer gets told to do its
    thing.
    - There will be a specific batch point where the chewer issues a batch fetch
      to process things.
  - We'll have this mechanism process groups as well.
    - Initially, we'll cram '@' for users and '#' for groups into the nick
      field.  This is almost certainly the wrong thing to do, but it's something
      to start from.
- For the MailAPI / UI:
  - MailPeep and plumbing to it will be updated to handle the enhanced
    dictionary structure.

### Phase 2


## Brainstorming (Archive)

### Phabricator and Bugzilla Mozilla use-cases

General setup and relationships:
- Bugzilla account:
  - There is a unique (normalized) ID that underlies each bugzilla account.
  - Bugzilla accounts use email addresses as the canonical UI representation of
    identities.
  - The email address associated with an account can change!
  - Mozilla bugzilla convention historically was to have one or more IRC nick
    permutations used as a human [Petname](https://en.wikipedia.org/wiki/Petname)-ish
    identifier.  This now seems to be a first class "nick".
- Phabricator:
  - Account is fundamentally tied to a bugzilla ID and thereby an email address.
  - Account explicitly results in a chosen username which is unique and normally
    the IRC nick.

API exposure:
- Bugzilla:
  - Get 2 representations:
    - "creator": "bugmail@asutherland.org"
    - "creator_detail":
      - nick: "asuth"
      - id: 151407
      - real_name: "Andrew Sutherland [:asuth] (he/him)"
      - name: "bugmail@asutherland.org"
      - email: "bugmail@asutherland.org"
- Phabricator:
  - Get a PHID, like in "authorPHID" for PHDI-XACT-DREV records.

### Identity Fusion

Gloda had an explicit `GlodaContact` class that represents a fusion of one or
more `GlodaIdentity` instances which had a "kind" like "email" and then the
actual "value".  There was also some level of object-relational-mapping (ORM)
going on such that a GlodaMessage would load the GlodaIdentity of the author /
receipients which would then load the GlodaContact which would then bring in the
rest of the identities.  (Note: Gloda guaranteed object identity invariants which
are explicitly not guaranteed by GELAM.  However, Gloda and GELAM's MailAPI do
both have a concept of what constitutes a live instance with liveness being
rooted in queries/collections in Gloda and view slice/lists in GELAM.  Gloda
leveraged XPCOM weak reference magic to track live collections whereas GELAM
requires explicit lifecycle management of the view slices/lists.)

It makes sense for GELAM to support a similar mechanism for identity fusion.
GELAM's existing ContactCache mechanism does understand multiple email addresses
but it exists exclusively in the front-end and is really just presentational to
keep the display name up-to-date and to allow web activities invocations to
directly reference the contact id.  There was never any UI for searches for
all emails from all of a contact's email address across all accounts, although
the unified folders mechanism would support such a thing.

For a cross-account per-contact timeline we would presumably want:
- A concept of contacts in the backend.
- A trigger-based mechanism that would derive virtual folders for each contact
  the user wants this for or speculatively would be interested in.  (For
  example, team Phabricator groups.)
  - A synthetic accountId could be allocated for the virtual folder space.
  - Or something more explicit could be created, perhaps its own table/store and
    perhaps without abusing the folder mechanism.
    - Might want to create a more explicit notion of **tags**, both
      **indexed tags** and **unindexed tags**.  All indexed tages would be
      indexed over time.
    - Gloda liked to emit emit highly normalized specialized indexy values which
      could be used to intersect sets and then mapped back to messages which
      could then have their time orderings processed.
      - Gloda didn't require everything would be indexed / expandos were
        supported.
  - It could make sense for indexed values to bias towards groups of tags that
    exist together in the same sorted ordering with specific tag values within
    the group then being filtered out.  The goal would be to avoid needing
    to union a crap-ton of indices when the normal usage would be to show all
    of them together and any faceted filtering would likely happen on top of
    that, possibly even in the UI.

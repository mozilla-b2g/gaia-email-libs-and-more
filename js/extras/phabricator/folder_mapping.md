## Meta

Note: The term Phabricator is used even when Differential might be a more
appropriate term.  Mozilla only uses Phabricator for code review purposes and
so Phabricator is synonymous with code review and there is almost no awareness
of any other capabilities Phabricator might posess.

- Phabricator is our first non-messaging account type.
- Phabricator is not that far removed from a messaging idiom, however, and this
  is reflected in the email it sends:
  - `X-Phabricator-To` headers are generated with the QID's for the patch author
    and the reviewers (or those involved in actions being taken), which includes
    projects/groups.
  - `X-Phabricator-Cc` headers are generated for subscribers which is a github
    style list of interested parties.
  - The human readable versions of To/Cc are also included at the bottom of the
    email.
- This rough correspondence to sent mail / mailing list subscriptions continues
  and is reasonably straightforward, although there is some level of inference
  that's necessary about the why.

## Mappings

### Stateful Labels

- Revision status:
  - Open
  - Closed
- Authorship related:
  - Review status:
    - needs-review
    - needs-revision
    - accepted
- Review-related:
  - User is blocking reviewer
  - User is non-blocking reviewer
  - User is member of blocking project / which project
  - User is member of non-blocking project / which project
- Discussion related (message):
  - type=inline: for line/range comments on the patch
    - State of `isDone` in the "fields" section of the PHDI-XACT-REV containing
      the "comments" array.  (That is, fields/comments are siblings, which is
      weird.)
  - type=comment: for top-level comments
  - Name-checks (not automatically parsed; `remarkup.process` can provide
    fancification, but it's just a raw-to-HTML conversion which then requires
    processing of the resulting DOM.  Probably better to use `mdast` natively.
    - Addressed name-check (local determination)
- Related bug-tracking info
  - Associated bugzilla bug
- Patch information
  - Directories the patch touches.
  - Bugzilla Components the patch touches.

### Folder Hierarchy

Reducing the above somewhat so that things that potentially churn like review
status can instead be part of a visual filtering inside the folder and/or
captured by overlays.

Phase 1:
- authored: (my patches)
- reviewer: (patches I should review or could help review)
  - me
  - [groups]
- patch directories:

Phase 2:
- feedback requested: patches with an unaddressed namecheck or a needinfo on the
  related bug.
- various user workflow tags.
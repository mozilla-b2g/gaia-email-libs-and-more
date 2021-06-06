Some BMO bugmail digging of actual observed mail.

I think the take-away is that

## Persistent Facty Stuff

Bucket identification is pretty good:
    X-Bugzilla-Product: Core
    X-Bugzilla-Component: DOM

Current assignee info is good:
  X-Bugzilla-Assigned-To: gsvelto@mozilla.com

Tracking flags are newish:
    X-Bugzilla-Tracking: tracking-e10s:+ status-firefox48:fixed


## Delta Stuff

### Release management triage


headers indicating what changed:
    X-Bugzilla-Changed-Fields: tracking-firefox46 tracking-firefox47
     tracking-firefox48 Comment Created
    X-Bugzilla-Changed-Field-Names: cf_tracking_firefox46 cf_tracking_firefox47
     cf_tracking_firefox48 comment

headers indicating aggregate state:
    X-Bugzilla-Tracking: status-firefox45:affected tracking-firefox46:+
     status-firefox46:affected tracking-firefox47:+ status-firefox47:affected
     tracking-firefox48:+ status-firefox48:affected
     status-firefox-esr38:unaffected tracking-firefox-esr45:?
     status-firefox-esr45:affected

Raw text:
               What    |Removed                     |Added
    ----------------------------------------------------------------------------
     tracking-firefox46|?                           |+
     tracking-firefox47|?                           |+
     tracking-firefox48|?                           |+

### Someone asking someone else something

    X-Bugzilla-Type: changed
    X-Bugzilla-Flags: needinfo?
    X-Bugzilla-Changed-Fields: CC Flags Comment Created
    X-Bugzilla-Changed-Field-Names: cc flagtypes.name comment

### Someone replying to someone on something

Explicit "\(In reply to (.+) from comment #(\d+)\)" for comment.

Gets headers:
    X-Bugzilla-Changed-Fields: Comment Created
    X-Bugzilla-Changed-Field-Names: comment

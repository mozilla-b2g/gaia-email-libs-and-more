Hypothetical Bugzilla integration.

## Motivation ##

I now need to watch and participate in Bugzilla components that have a lot going
on.  This happens for several reasons:
* Aggressive / proactive triaging results in triage delta sweeps.
* Potentially large patch-sets result in fixes on a bug necessitating multiple
  attachments and potentially multiple sets of review comments.
* The bugzilla components are not as granular as the implementation.  More
  granular bugzilla components are feasible, but are potentially confusing to
  everyone but those doing the work.  And those doing the work frequently wear
  many hats / are seemingly omniscient and would read everything anyways.

When I'm reading my bugmail, these are my primary use-cases:
* Awareness: Keep track of what's going on.  Usually a low priority and also
  much more voluminous than all other streams of data for me now.
* Assist: Help others accomplish their goals.  Reply to needinfo/feedback/review
  flags.  The introduction of the needinfo flag greatly has simplified
  determining when assistance is explicitly required.
* Do: Interacting on my primary tasks.  The flip side of "assist" where I want
  to know when others respond to my assistance.

## Desired UX ##

* Organize bug activity into streams corresponding to awareness/assist/do,
  potentially further sliced up by other organizational boundaries.  For
  example, assist in Core::DOM is a multiple-times-a-day priority for me, but
  assist in Thunderbird/MailNews::* is an end-of-day thing.
* Aggregate batch mutations spanning multiple bugs by other users.  These
  manipulations are still relevant if viewing the bugs for other reasons and
  should be displayed, but should not merit display of the bug on its own.
  * Attempt to categorize/summarize these manipulations.  For example,
    "triage pass", "merge to mozilla-central from mozilla-inbound", and
    "release management sweep" are all common reasons for a bunch of consecutive
    mutations to occur.
    * Support smart summarization of these manipulations under a heading.  For
      example split out approved for uplift and not approved for uplift.  This
      could possibly end up with a live faceting mechanism if the count is
      big enough or whatever.
  * Cluster/suppress transitive notifications as appropriate.  I don't really
    need to see N separate messages for a manipulation of a single bug's
    dependencies that added N bugs.
  * Potentially cluster/linearize by person; the narrative of what that person
    got up to is more useful than the wall-clock interleaving of multiple
    narratives.  The exception is, of course, triage groups, but frequently
    one person ends up being the responsible party so it turns out okay.
* Aggregate/summarize co-contributor activity for changes I'm not specifically
  interested in.  Even if I don't care about the specific activity, being able
  to see that others are spending a lot of activity on certain bugs still is
  useful contextual information to me.
* See newly filed bugs with potential to toss them into piles that impact how I
  see the bugs in the future:
  * important, direct to "assist" or "do" sub-stream.  Possibly also bounce to
    some other top-level stream (ex: Thunderbird).
  * suppress-until-contributor-activity
* Explicit support to delve into the "what was ignored" bucket.  Just like you
  can go looking in your spam folder to make sure things aren't going horribly
  wrong, I need to be able to see what is being ignored, and ideally why.  This
  need not be particularly fancy, just an unoptimized debug surfacing of traits
  that caused things not to be displayed elsewhere.

## Implementation Complexities ##

### Bugmail as content is a no-go ###

The representation of bug changes in bugmail is not as immediately useful as the
REST API's JSON representation.  Most of the information is there, but it's
flattened into headers for filtering and styled text or HTML for human
comprehension.  The data can re-inferred/extracted from these representations
(the original gloda plugins for bugzilla did it:
https://github.com/asutherland/gp-bugzilla/blob/master/modules/attr_bug.js) but
that's basically the definition of a bad idea.  Especially since there's no way
to get bugzilla to retroactively provide information in that munged format and
the format has changed over time.

### Bugmail as a sync trigger and store of secondary info can work ###

A Bugzilla account type of its own makes a fair amount of sense.  There's a
canonical protocol to speak with the server (the REST API), we're syncing a
subset of things, etc.

One complication is server support for per-user private information.  For
example, in Discourse, the server is able to explicitly track read/interest
status for threads.  In Bugzilla there are some shared-state mechanisms for
expressing interest like adding oneself to the CC list.

One limitation is that the Bugzilla server has very limited per-user private
state management.  (Compare with Discourse where the server can track
read-status of specific topics.)  I mailed the BMO list to ask about the
per-user tag efficiency/overhead but didn't her anything back, so we'll just
assume abusing the tags is a bad idea.  (Specifically, we'll assume that this
whole effort of ours will not pan out but could have non-trivial costs to BMO
or at least our account, and we don't want to posion the well or wedge up our
account.)

### Tentative Plan ###

* Define a bugzilla account type.
* Have the bugzilla account sniff non-bugzilla accounts for bugmail messages,
  probably using a trigger.
  * The trigger will generate update request tuples of the form (bug number,
    highest known comment number/timestamp).  The plan phase will discard
    requests that are already satisfied by local state, so growing back in time
    will not result in wasted work.
* Maintain a local per-bug store of meta-information that we treat as
  authoritative, including per-comment annotations.
  * It will not initially be synchronized, but we will attempt to perpetuate the
    data through upgrade cycles at some point.
  * The mid-term plan is to reflect the state onto the bugmail messages where
    possible.  For example, starring and tagging specific messages of interest.
    And messages that are not interesting and do not otherwise carry metadata
    can be purged.
* Expose a date-ordered change-centric index or view to allow for the
  aggregating UI.  Index is probably best, as summarizing logic is going to want
  access to the current bug in its entirety, especially to identify things that
  were contradicted or later changed.  Ex: landed but backed out.  This may
  necessitate an alternate viewslice/list aggregate?

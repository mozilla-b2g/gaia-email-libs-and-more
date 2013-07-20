## Coding Guidelines / Implementation Decisions ##

### Naming / Idioms ###

- File names: lower_case_with_underscores

- Class names: UpperCamelCase

- Variable names: lowerCamelCase

- Module variable names: consistent with variable naming: var moduleName =
  require('module_name');

- Constant-ish things: CAPITALS_WITH_UNDERSCORES on the constructor.  If it's
  something that can vary, make it a first-class argument to the constructor
  (possibly in a dictionary/bag of things that then gets mixed-in.)

- Bags of constants: Create a function that returns an object that can then be
  passed to the constructor.  This helps with unit tests since we don't need to
  clobber singleton objects/modules/etc.  The currently existing syncbase.js
  wants to be converetd to this idiom.

In all other cases, defer to the Gaia coding guidelines.

### Modules ###

We use AMD-style modules (https://github.com/amdjs)

Boilerplate idiom going forward is one of the following.

Return exports:

    define(function(require) {
    var a = require('a')

    // ...

    return {}; // our exports
    });

Or set exports (module may also be optionally specified; 'loggest' likes it.)

    define(function(require, exports) {
    var a = require('a')

    // ...

    exports.blah = blah;

    // ...
    });

Current code uses an explicit dependency list, but people seem to dislike that
boilerplate, so we're abandoning in favor of the above.

### Libraries ###

- We are general okay with Promises although we haven't used them yet.
  Node-style callbacks are still preferred in simple cases where there is no
  chance of the callback firing multiple times.  It's a judgement call, really,
  but don't be afraid to use promises.

- We want to use co (https://github.com/visionmedia/co) for driving generator
  logic.

### Documentation / Typing ###

- We want jsdoc-style documentation blocks on all methods.

- There is no requirement to place explicit typing information inside function
  bodies for type-checking tools, but developers can do so if they want.  In
  other words, if you use a type-checker, the burden is on you to make it go,
  etc. and breaking any continuous integration runs of the type-checker is not
  enough to back-out a patch on its own.  This could change in the future if
  static type checking turns out to be awesome and saves our butts a lot, etc.

### Representation/Invariant Checking ###

As noted above, there is no tooling requirement for type-checking.

However, we do think it would be a good idea to have logic in code that persists
data to long-term storage in IndexedDB to check the validity of that data.
These functions can be hand-written, or fancy people can use automated tooling
to (manually) generate the function.  The checking function should ideally not
exist on the critical path for anything.  If it does, it might be suitable to
only turn it on during unit tests.

## Issue Tracking ##

All bugs are currently tracked on bugzilla.mozilla.org in the "Boot2Gecko"
product under the "Gaia::E-Mail" component.  We do this for a variety of reasons
involving expressing dependencies, limitations in the github issue
functionality, and having been shot in the foot many times by the tagging
implementation.

To get a list of open bugs, you can use the following link:
https://bugzilla.mozilla.org/buglist.cgi?product=Boot2Gecko&component=Gaia%3A%3AE-Mail&resolution=---&list_id=6947508

Our conventions are:

- We put [email], [email/IMAP] or [email/activesync] in the front of the bug
  title.  This is primarily done because our commits include the bug number and
  title in the commit in Gaia and it makes it a lot easier to tell what bugs are
  relevant to the e-mail app and which are not.  Feel free to add these prefixes
  to bugs that lack them.

- One bug per Gaia pull request, which may depend on one
  gaia-email-libs-and-more pull request.  This is done primarily for uplift
  sanity.  It gets very confusing if one bug involves multiple pull requests.
  The fallout from this is that you may need to create separate bugs and request
  blocking / permission flags and you may want to do this earlier since it can
  sometimes take a few days to get the flags propagated by the triagers.

- For small changes that exist only in gaia-email-libs-and-more such as
  documentation changes or very minor (aka stupid) test fixes, you do not need
  to create a bugzilla bug.  However, you will need to manually ping for review
  from an appropriate reviewer somehow; bugzilla's request flag system is our
  canonical and only official means of tracking reviews.

The list of bugs will include Gaia E-Mail app UI bugs in addition to back-end
(gaia-email-libs-and-more) bugs.

### Bug Awareness ###

The best way to keep track of what's going on with the e-mail libraries before
they land is to watch the component.  While signed in to bugzilla.mozilla.org,
click on "preferences" in the header, then click on the "Component Watching"
tab.  Then change the Product selector to "Boot2Gecko" and once the Component
list updates, select "Gaia::E-Mail" from the list and click the "Add" button
below it.

### Dashboards ###

Want to keep track of what you are working on?  You can try the "My Requests"
link on bugzilla.mozilla.org pages at the top, or you can try one of the many
bugzilla dashboards out there.

We recommend http://bugmotodo.org/ as a powerful but simple dashboard.


## Contributing Code ##

### Work on a bug ###

To make sure other contributors know what you are up to, it's helpful to have an
up-to-date bug to let others know what you are working on.

If there is already an existing bug that covers what you want to do and it's not
assigned, assign the bug to yourself.  If you don't have the permissions for
that, ask for it to be assigned to you by posting a comment on the bug.  If
someone is already assigned to the bug and there is no recent status on the bug
or indicated on any related pull requests in the past few days, it's quite
reasonable to post a comment on the bug asking about the status of the bug and
indicating that you'd like to try your hand at fixing the bug.

If there isn't a new bug, create a new bug!

If the problem is non-trivial and the bug doesn't already have a solution
proposed by one of the reviewers listed below, it's strongly suggested that you
propose your enhancement as early as possible in a comment on the bug.  That way
you don't start working on a fix that might turn out to have technical problems
or would not be accepted for other reasons.  You don't have to wait for feedback
before starting on your fix, of course.


### Putting code up for review ###

- Create a pull request against mozilla-b2g/gaia-email-libs-and-more.

- Link to the pull request from the related bug by creating an attachment on the
  bug.  There is a Firefox extension at
  https://addons.mozilla.org/en-US/firefox/addon/github-tweaks-for-bugzilla/
  that is very helpful.

- Set the "review" flag to "?", entering the e-mail address for one of the
  reviewers listed below.


### Updating a pull request ###

After you have created your pull request it is preferable that you add new
commits and *do not squash the commits in the patch* until review of the patch
has completed.  It is okay to rebase the stack of patches in its entirety if
your patch is very out of date relative to 'master' and you think the merge
makes things look confusing.  This is to make the reviewer's life easier since
they can just look at the commits that have changed since they last looked at
the patch.  You will still be able to rebase and squash the patch once the patch
has been fully reviewed.

The reviewer won't be automatically notified when you push new commits on your
pull request, so if the reviewer has indicated they have completed their review
by causing the review flag to no longer be "?", you will need to re-set the
flag.  Or if the flag is still there but the reviewer indicates they are waiting
for further commits, you should make a comment on the bug so they know about the
new commits.


### Reviewers ###

Here's the current state of reviewers; they can also defer reviews to people not
on this list or request reviews of people not on this list.  Once people become
more experienced with the code-base they will be added to the list.  People
trying to escape the code-base can be removed from the list.

James Lal (core, IMAP)
- Mozilla IRC: lightsofapollo
- Mozilla bugmail: jlal@mozilla.com
- github: lightsofapollo

Jim Porter (some core, some IMAP, activesync)
- Mozilla IRC: squib
- Mozilla bugmail: squibblyflabbetydoo@gmail.com (autocompletes on ":squib")
- github: mozsquib

Andrew Sutherland (core, IMAP, some activesync)
- Mozilla IRC: asuth
- Mozilla bugmail: bugmail@asutherland.org (autocompletes on ":asuth")
- github: asutherland


# Layout #

Note: See config.md for an overview of the concepts and rules that impact
layout.

Layout is done as part of the log processing stage and can be thought of as
a pre-chewing for the rendering layer.

## Simplifying Techniques ##

Layout of (log) timelines is hard.  There's potentially a bunch of boring and
also verbose stuff happening in a short period of time.  There's a need to
display things in sequential order while also have some sense of time.

### Meta: Punt on the hard stuff ###

Constraint solvers and optimization processes are awesome, but if you've dealt
with graphviz and big graphs, you know there's only so much computational magic
can do on its own.

If the log looks like a mess, we leave it up to the human user of the log viewer
to either make things explicit via our yaml configuration files or to use our
interactive affordances to mitigate things.  We endeavor to make it reasonably
easy to incrementally enhance the configuration.

### Lanes: User-Sized with Hidden Vertical Overflow ###

If you're used the amazing SIMILIE timeline widget or other timeline layouts,
the big problem they all run into is that if you compress time enough, all your
events stack up into a homogeneous vertical mess.

Our solution to this is that lanes in the UI are all manually vertically sized
with splitter-ish things and the configuration makes it easy for you to throw
too-verbose things into lanes which you can size into oblivion.

### Automatic parallel event coalescing/grouping ###

A common problem with normal log reading/viewing is being faced with chatty
output that you don't think you care about.  You either end up skimming past it
in high-speed scrolling/paging, using searching to jump and hope you don't miss
much, or filter out that class of log lines entirely.  All the solutions have
downsides.  This chatty output is also the type of thing that can be a nightmare
for layout, causing vertical spamming.

Because our logging is already structured by namespace and event name, we have
an easy default means of deciding what things are alike an coalescing them in a
way that console.log() and friends do not... in parallel!  This is believed
safe and awesome because if the user wants to see what's inside, they can do so
just by clicking on the thing.  And then they can see it vertically too in a
big popup thing, which is probably how one would want to see such things.

Of course,

Our algorithm is quite simple.  Within our current hierarchy level and lane we
maintain a Map keyed [namespace, event].  As we process events, we pass them
to the `ConfigApplier` that applies all configuration rules.  Once we have this
`ruledEvent` we know wha

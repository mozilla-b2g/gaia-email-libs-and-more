# Visualization and Faceting #

Visualization and faceting support using Vega (http://vega.github.io/).  Vega
is a declarative visualization grammar encoded using JSON.  It builds on top of
other cool visualization libraries you may be more aware of, such as d3.  Its
declarative JSON nature means that it is significantly more practical to safely
share visualizations with other users than it would be if all visualizations
were implemented as JS code.

Note: Effort will be required on our part to help ensure Vega is safe to use for
sharing purposes. Specifically, the potential for exfiltration of data via URLs
that reference external resources is a large concern.  Additionally, it appears
that the expression language may involve dynamic code generation via eval/new
Function(code), which would also need to be audited and potentially secured.

## Overview ##

### Goals ###

We don't want to reinvent the wheel.  Anything Vega can do, we want Vega to do
it.  The exceptions are that:

* We don't want to depend on Vega for our core search/filtering functionality.
  More specifically, we want to be able to transform core search/filter requests
  into something that we can ask a back-end IMAP/JMAP/whatever server.  Vega's
  expression language (https://github.com/vega/vega/wiki/Expressions) is quite
  expressive and although we could eventually try and consume the AST to map
  what is possible for the server query, it's simpler right now to avoid that
  complexity entirely.

* We will make decisions that help us perform data decimation in the worker so
  that our memory usage can be kept reasonable through streaming processing and
  sending the front-end / main thread only the data it actually needs for
  visualization purposes.


### Who Does What ###

* GELAM backend and data gatherers (in the worker): Responsible for providing
  the content of messages and conversations.  Also the place where GELAM
  extensions would add additional gatherers (versus in vega somehow).  The
  intent being that these can then be used for standard search filtering and
  display even without this extra active.

* Vega in the worker: Logic in this extra scours the provided vega definitions
  to create a single dataflow pipeline to provide primary data-sources.  (Vega
  is said to be smart about reusing things, so hence cramming things together.)

* Vega in the front-end: The standard vega flow occurs, but with the exception
  that data computed by the back-end is declared only as a streaming source that
  is directly fed into the visualization.

### Data Plumbing and List Views ###

## Desired Visualizations / Facet Views ##

### Top Wide Overviews ###

Wide visualizations that span the width of the conversation / message list.
More viable for brushing, but these can be facets too; there's just only space
for a limited number of them, so these need to be more heavily curated.

* Sparkline histograms of message activity (count per time unit) faceted by:
  * mailing list
  * author categorization
* Scatterplot of messages: x=date, y=body length, color=author categorization

### Sidebar Views ###

Narrower visualizations, usually displayed as part of a facet option.  Usually
not suitable for brushing because of the reduced screen real estate available
because these will tend to need to be small multiple type things.

* Sparkline histograms of message activity faceted by:
  * author
  * mailing list
  * folder (if not already limited to one)
  * tags, including specialized ones like starred, read/unread
  * labels
  * message state: replied to, forwarded
* tag/label word clouds
* significant terms word clouds

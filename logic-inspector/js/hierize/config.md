# Log Processing Configurations #

We support configurable higher level transforms of the flat log stream into
something that you might sketch out on paper to figure out what is going on.

Configurations are specified in a ad-hoc yaml configuration file that will
probably make sense but also feel like there must be a better way.  And I'm
sure there is!  A simple exercise for the user!

## Concepts ##

* Lanes: Lanes are vertical bands that log events are displayed in.  Every log
  event goes in a lane.  Lanes are eternal and should roughly correspond to
  a subsystem view of what's going on.  For example, you might have lanes for
  "database", "network", "UI".
  * Hierarchical lanes:
* Nesting: Although our log events are flat, things going on in the system are
  likely to be clustered by requests/tasks/etc.  
* Coalesced events: Coalesced events create a single horizontal strip on the
  timeline that contains two or more events that were bucketed together.  They
  are expressed textually.
* Lifelines: Specialized aggregate to express the life-cycle of important /
  expensive resources that can be long-lived and can be graphically expressed
  in a vertically compact fashion.  For things like TCP connections and
  wake-locks which are subject to pooling and whose continued existence can be
  expensive.  Contrast with coalesced events which may take up a reasonable
  amount of vertical space and are all about when the event happens and we don't
  want them existing for a really long horizontal span.


## Directives ##

The configuration yaml file is a mapping at the top level whose keys are logger
namespaces and whose values are mappings.  These mappings' keys are event names
whose values are in turn mappings consisting of (named) directives.

Example:

```
LoggerNamespace1:
  event1:
    directive-a: whatever
    directive-b: "yeah, whatever"
  event2:
    directive-c: ["totes"]

LoggerNamespace2:
  event3:
    directive-d: "blah"
```


Value conventions:
* property-reference: A yaml string that starts with a "$" that indicates that
  we want to refer to a property on the event.
* list-as-namespace: A list where each element is either a string or a
  "$"-prefixed log property reference and the aggregate is treated as an
  identifier in a unique namespace.
* list-as-string: A single string or a list where each item in the list is
  either a string or a "$"-prefixed log property reference and all the pieces
  are concatenated together to form a single string.  Spaces are not
  automatically injected, so you will need to pad manually.
* list-as-hierarchy: A list where each item in the list represents a level of
  hierarchy.  Each item is either a string or a "$"-prefixed log property.
  (This precludes using computed strings for levels of hierarchy.  Sorry!)


### Magic Names ###

* WILDCARD at root level: Its value is a mapping of directives to be applied to
  all events first.
* WILDCARD under a logger namespace: Its value is a mapping of directives to be
  applied to all events with the given namespace after any root wildcard
  directives and before event-specific directives are applied.  Directives
  can/will clobber root wildcard directives, and may in turn by clobbered by
  event-specific directives.

### Lanes ###

* lane: list-as-hierarchy.  Each item in the list is a level of lane hierarchy.

### Nesting ###

* nest-start: list-as-namespace.  Starts a nested node with the given namespace.
* nest-end: list-as-namespace.  Ends the nested node with the given namespace.

* nest-if: property-reference.  Marks that nest-under should only be applied if
  the given property is present and truthy.
* nest-under: list-as-namespace.  Nest this

### Coalesce ###

As described in our layout documentation, by default we will try and
automatically coalesce runs of events in a namespace of the form
[LoggerNamespace, EventName].  A coalesced run is closed either when an event
encountered with coalesce-barrier is encountered or heuristics decide "eh,
it's been long enough."  Once the heuristics are ironed out, it will probably
make sense to let more explicit stuff happen.

* coalesce: boolean, default is true.
* coalesce-under: list-as-namespace.  Use some difference namespace other than
  the default one implied by the logger's namespace and event name.
* coalesce-barrier: list-as-namespace.  Does this event constitute
  something notable that should cause us to close all open coalescings?  You
  would use this for really notable things like releasing a wakelock.  The
  namespace aspect of this is speculative right now, but the idea is that it
  makes sense for us to name these barriers so later code can opt-in/opt-out
  from the specific barrier.


### Lifelines ###

* life-start: list-as-namespace.  Starts a lifeline with the given namespace.
* life-label: list-as-string.  Provides the label to use for the lifeline.  This
  is only used when there is also a life-start directive prsent.
* life-end: list-as-namespace.  Ends a lifeline with the given namespace.

* life-under: list-as-namespace.  Marks this event as associated with the given
  lifeline and that it should not otherwise be displayed.
* life-link: list-as-namespace.  Speculative.  This event will still be
  displayed per other directives, but will also be linked to the lifeline
  somehow.
* life-phase: list-as-string.  The phase to use to describe the current phase of
  the lifeline as of this event.
* life-mark: string.  Speculative.  Indicate something interesting happened on
  the life life by putting a marker on it.


### Rules ###

Rules allows a set of directives to be applied conditionally based on inspection
of the event.  

* rules: The value is a sequence whose items are either:
  * mappings containing conditionals and directives to be applied if the
    conditional(s) are satisfied.  All rules will attempted to be matched and
    executed in sequence, with later matches taking precedence.
  * mappings with a single key that is `one-of` and whose value is a sequence
    of the former case (mappings containing conditionals and directive) except
    where we will stop once we find the first rule that matches.

Example of everything, why not:
```yaml
LoggerNamespace:
  Event:
    rules:
      # lane choice ends up being mutually exclusive anyways, so use one-of.
      - one-of:
        # use a capturing group for this match so "foo[2]: " ends up in
        # ["foo", "2"] (where 2 is a string, though.)
        - match: [$prop, "^foo\[(\d+)\]: "]
          lane: [foo, $1]
        - match: [$prop, "^bar: "]
          lane: [bar]
      - has-prop: $contextId
        nest-under: [context, $contextId]
```

#### Conditionals ####

* has-prop: property-reference.  Causes the rule to match if the property is
  available.
* match: A list whose second element is a regular expression (in string form)
  and whose first element is a "$"-prefixed property reference that we should
  run the regexp against.  Note that the regexp will not be tested if the
  property does not exist.  If there are any capture groups in the regexp, then
  they will be exposed to the action parts of the rule as $1/$2/etc.

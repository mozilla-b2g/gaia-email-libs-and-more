This folder is home to logic that runs during the finishTask stage of tasks,
adding new tasks or atomically mutating always in-memory data structures.
The idea is analogous to that of SQL triggers, hence the name.

The intent is to support aspect-oriented logic that would otherwise clutter up
the code-base.

Our canonical example is that of maintaining unread counts for folders.
Although not exceedingly complicated logic, it's also not trivial and something
that can definitely be screwed up.

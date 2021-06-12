Musings on streams informed by :mcav's initial streaming efforts.

## Advantages of Streams ##

* Allow the server to pipeline data and have the server benefit from locality
  on its accesses.
  * In particular, avoiding the network roundtrip is beneficial on its own, but
    there are also cases like gmail where there can be non-trivial secondary
    latency within the data-center to access storage, etc.
* Better model what is happening under the hood with MIME messages.
  * (The best model might be a somewhat explicitly aware tree API that emits
     streams as it goes.)
  * We may potentially end up slurping down raw MIME in the future.
* Backpressure
* Ability to stream data to disk when the platform allows it.  (It's very sad
  that the platform does not provide this yet.)

## Interaction With Tasks ##

### Tensions ###

Tasks:

* Explicit simplicity goal for tasks, which works nicely at keeping things
  atomic and bite-size, but with the potential for paying a high overhead cost.
  But the task model was intentionally designed so that we could potentially
  defer those costs while still apparently having the strict boundaries.
  * The locking discipline for tasks and the API ergonomics really want tasks
    to ratchet up to write-locks on things at the last moment when they are
    I/O bound and do not need to wait for any network traffic.
* The current tasks model assumes to some extent that the TaskManager is in
  charge of scheduling things and that most synergies can be realized by
  running multiple tasks in parallel and having ParallelIMAP pipeline things and
  use multiple connection.


## Solutions ##

### Maintaining Atomicity ###

* More coherent checkpointing support.
  * dangerousIncrementalWrite was added to support the draft_attach use-case.
    Something similar with explicit checkpointing could theoretically work, but
    it really complicates the lock concept

* Allow tasks to spawn off sub-tasks:
  * A streaming task would construct the stream in its outer/top-level task, and
    that as interesting things happened stream-wise, sub-tasks provided as
    registered promises/generators would spawn off, each of which would have
    their own locky-transaction model, with the locks being happily released on
    completion.
  * Subtasks as monotonically advancing the state of the task.
    * Practically, our goal is just that it's clear that the state updates are
      still occurring atomically.
    * In the case of downloads, the additional blob piece
  * Create lighter-weight convenience helper where a single object is acquired
    for write purposes, possibly with automatic read-back for Blob laundering
    afterwards.  Key aspects:
    * It's allowing direct access with potentially complicated stuff inside
      there.  It's avoiding the "hey I directly mutated something and am
      writing for state change, but things could screw up" scenario, as well as
      the arguably awkwardness of out atomicClobber stuff which absolutely does
      not scale up.
    * The logic is confined to a function so if it throws, we can very directly
      detect it.  Although, arguably, it's not clear this is particularly
      beneficial since it seems like it should also kill the outer thing.
  * Examples:
    * For the case of

#### Subtask Examples ####

POP3 message download.  This is

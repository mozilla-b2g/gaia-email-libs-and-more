## Moving Pieces ##

### By Context ###

* Document Context:
  * GELAM:
    * mozAlarms code that ensures all account syncs are scheduled.
  * "App Logic" exposed to/used by GELAM:
    * Responsible for
  * Consumer logic (app logic that uses the GELAM API, not driven by it):
* (Dedicated)Worker Context:
  * GELAM:
  * "App Logic" exposed to GELAM:

### Order of Operations ###

This is what a cronsync looks like:

1. The front-end is started.  A clever front-end like gaia mail will use
   mozHasPendingMessage('alarm') and the visibility API to infer that it was
   launched in the background and accordingly avoid most UI spin-up.
1. The back-end is brought up (eventually) by the front-end.
  1. The front-end loads main-frame-setup which causes the worker to be created
     and all of the main-frame helpers in worker-support to be loaded.
  1. The cronsync-main logic invokes mozSetMessageHandler('alarm') which
     (synchronously) invokes the provided callback if there are any.  (The
     callback will also be invoked asynchronously if the alarm fires when our
     app is still active, but we really don't need to think about that.)
    1. The callback will acquire a cpu wakelock because for correctness we must
       acquire one before returning.
    2. The callback will send a router message to the worker.
1. cronsync_support in the backend's worker will receive the router message from
   cronsync-main.
  1. A bounded-log entry is immediately written to the database and its
     identifying information saved off so that the entry can be updated as the
     cronsync progresses.



## Task Hierarchy ##

Cronsync relies on the following tasks:

* cronsync_ensure: Ensures that our wakeups are registered with mozAlarms.
* cronsync_group: Perform cronsync for one or more accounts.  Directly triggered
  by the requestsync alarm/wakeup.  Exists to create a task group that ties
  together all the individual cronsync_account tasks.
* cronsync_account: Performs the actual synchronizing.


* cronsync_task_spinoff

## Bounded Log Entries ##

We write a log entry with id '!batch' for each batch, plus one log entry for
each account where the id is the account id.  The per-account entries use the
same timestamp as the batch to avoid ambiguity.

### Batch Entry ###

The following values are initially populated when we first add the record during
the onAlarm invocation.
- startTS: The timestamp of when the 'alarm' was processed by CronsyncSupport's
  onAlarm function.  This will also be the same as the timestamp used as a key
  for the record.
- startOnline: The value of navigator.onLine



- endTS: The timestamp for when the

### Per-Account ###

## Moving Pieces ##

* Front-End


## Task Hierarchy ##

Cronsync relies on the following tasks:

* cronsync_ensure: Ensures that our wakeups are registered with the requestsync
  API.
* cronsync_group: Perform cronsync for one or more accounts.  Directly triggered
  by the requestsync alarm/wakeup.  Exists to create a task group that ties
  together all the individual cronsync_account tasks.
* cronsync_account: Performs the actual synchronizing.

define(function(require) {
'use strict';

let co = require('co');
let evt = require('evt');
let logic = require('logic');

let TaskContext = require('./task_context');

let FibonacciHeap = require('./ext/fibonacci-heap');

/**
 * The public API and ultimate coordinator of all tasks.  Tracks and prioritizes
 * the pending tasks to be executed.  Also handles some glue logic and is likely
 * to be the home of ugly hacks related to tasks.  Compare with:
 * - `TaskDefiner`: Exposes helpers/mix-ins for the implementation of tasks.
 * - `TaskRegistry`: Tracks the known global and per-account tasks and drives
 *   the actual execution of the tasks once TaskManager has decided what should
 *   get executed.  `TaskManager` and its creator, `MailUniverse` handle some
 *   glue logic.
 * - `TaskContext`: Provides the execution context and helpers for tasks as they
 *   are run.
 *
 * Tasks will not be processed until the `MailUniverse` invokes our
 * `__restoreFromDB` method and we have fully initialized all complex tasks.
 * (Complex task initialization can be async.)
 */
function TaskManager(universe, db, registry, accountsTOC) {
  evt.Emitter.call(this);
  logic.defineScope(this, 'TaskManager');
  this._universe = universe;
  this._db = db;
  this._registry = registry;
  this._accountsTOC = accountsTOC;

  // XXX SADNESS.  So we wanted to use autoincrement to avoid collisions or us
  // having to manage a counter.  Unfortunately, we want to use mozGetAll for
  // retrieval, but that can't include the keys, so we need to always have
  // the key inside the value.  To avoid managing the counter we go with a
  // strategy to avoid colliding keys, probably.  We use Date.now and then
  // assume that we won't generate tasks at a sustainted rate of more than 100
  // tasks per millisecond (on average).
  let idBase = (Date.now() - 1400000000000);
  if (idBase < 0) {
    throw new Error('clock is bad, correctness compromised, giving up.');
  }
  this._nextId = idBase * 100;

  /**
   * @type{RawTask[]}
   * The tasks that we still need to plan (but have scheduled/durably persisted
   * to disk.)
   */
  this._tasksToPlan = [];

  /**
   *
   */
  this._prioritizedTasks = new FibonacciHeap();

  /**
   * Maps priority tags to the FibonacciHeap nodes holding a simple wrappedTask
   * or a complex task marker.
   */
  this._priorityTagToHeapNodes = new Map();
  /**
   * @type {Map<String, Map<String, Number>>}
   * Maps owners to their current maps of priority tags and their relative
   * priority boosts.  (Positive numbers are a boost, negative numbers are a
   * penalty.)
   */
  this._priorityTagsByOwner = new Map();

  /**
   * Maps priority tags to the sum of all of the values in the maps stored in
   * _priorityTagsByOwner.  Keys/values are deleted when they go to zero.  This
   * is updated incrementally, not re-tallied.
   */
  this._summedPriorityTags = new Map();

  /**
   * Maps a marker id to the priority heap node that contains it.  Used so that
   * as complex tasks update their markers (functional-style, they do not
   * retain a reference to their marker and are forbidden from manipulating the
   * markers after the fact for sanity reasons) we can re-prioritize the
   * markers.
   *
   * Markers are removed from this map exactly as they are triggered to execute.
   */
  this._markerIdToHeapNode = new Map();

  // Wedge our processing infrastructure until we have loaded everything from
  // the database.  Note that nothing will actually .then() off of this, and
  // we're just using an already-resolved Promise for typing reasons.
  this._activePromise = Promise.resolve(null);
}
TaskManager.prototype = evt.mix({
  __restoreFromDB: co.wrap(function*() {
    let { wrappedTasks, complexTaskStates } = yield this._db.loadTasks();
    logic(this, 'restoreFromDB', { count: wrappedTasks.length });

    // -- Restore wrapped tasks
    for (let wrappedTask of wrappedTasks) {
      if (wrappedTask.state === null) {
        this._tasksToPlan.push(wrappedTask);
      } else {
        this.__prioritizeTaskOrMarker(wrappedTask, 'restored', true);
      }
    }

    // -- Push complex task state into complex tasks
    let pendingInitPromises = [];
    this._registry.initializeFromDatabaseState(complexTaskStates);
    this._accountsTOC.getAllItems().forEach((accountInfo) => {
      pendingInitPromises.push(
        this._registry.accountExistsInitTasks(
          accountInfo.id, accountInfo.engine)
        .then((markers) => {
          this._prioritizeTasksOrMarkers(markers);
        }));
    });
    this._accountsTOC.on('add', (accountInfo) => {
      this._registry.accountExistsInitTasks(accountInfo.id, accountInfo.engine)
        .then((markers) => {
          this._prioritizeTasksOrMarkers(markers);
        });
    });
    this._accountsTOC.on('remove', (accountInfo) => {
      this._registry.accountRemoved(accountInfo.id);
      // TODO: we need to reap the markers
    });

    // -- Trigger processing when all initialization has completed.
    Promise.all(pendingInitPromises).then(() => {
      this._activePromise = null;
      this._maybeDoStuff();
    });
  }),

  /**
   * Schedule one or more persistent tasks.
   *
   * Resolved with the ids of the task once they have been durably persisted to
   * disk.  You should not care about the id unless you are a unit test.  For
   * all user-visible things, you should be listening on a list view or a
   * specific object identifier, etc.  (Ex: if you care about an attachment
   * being downloaded, listen to the message itself or view the list of pending
   * downloads.)
   *
   * This method should only be called by things that are not part of the task
   * system, like user-triggered actions.  Tasks should list the tasks they
   * define during their call to finishTask.
   *
   * @param {RawTask[]} rawTasks
   * @param {String} why
   *   Human readable but terse label to explain the causality/rationale of this
   *   task being scheduled.
   * @return {Promise<TaskId[]>}
   *   A promise that's resolved with an array populated with the
   *   resulting task ids of the tasks.  This is a tenative babystep
   *   towards v3 undo support.  This may be removed.
   */
  scheduleTasks: function(rawTasks, why) {
    let wrappedTasks = this.__wrapTasks(rawTasks);

    logic(this, 'scheduling', { why: why, tasks: wrappedTasks });

    return this._db.addTasks(wrappedTasks).then(() => {
      this.__enqueuePersistedTasksForPlanning(wrappedTasks);
      return wrappedTasks.map(x => x.id);
    });
  },

  /**
   * Return a promise that will be resolved when the tasks with the given id's
   * have been planned.
   */
  waitForTasksToBePlanned: function(taskIds) {
    return Promise.all(taskIds.map((taskId) => {
      return new Promise((resolve, reject) => {
        this.once('planned:' + taskId, resolve)
      });
    }));
  },

  /**
   * Schedule one or more non-persistent tasks.  You only want to do this for
   * tasks whose arguments are things that should not be persisted to disk and
   * for which it's expected that the task will run quickly.  The canonical
   * example is attaching files to a draft where we (currently) encode in
   * bite-size chunks.  (Noting that we want to change this.)
   *
   * In general you don't want to be calling this.
   */
  scheduleNonPersistentTasks: function(rawTasks, why) {
    let wrappedTasks = this.__wrapTasks(rawTasks);
    wrappedTasks.forEach((wrapped) => {
      wrapped.nonpersistent = true;
    });
    this.__enqueuePersistedTasksForPlanning(wrappedTasks);
    return wrappedTasks.map(x => x.id);
  },

  _computePriorityForTags: function(priorityTags) {
    let summedPriorityTags = this._summedPriorityTags;
    let priority = 0;
    for (let priorityTag of priorityTags) {
      priority += (summedPriorityTags.get(priorityTag) || 0);
    }
    return priority;
  },

  /**
   * Updates the priority boost tags associated with the given owningId, like
   * when the user changes what they're looking at.  Pass null to clear the
   * existing priority boost tags.
   *
   * @param {String} owningId
   *   A non-colliding identifier amongst the other priority users.  The
   *   tentative convention is to just use bridge handles or things prefixed
   *   with them since all priorities flow from explicit user action.
   * @param {Map} tagsWithValues
   *   A map whose keys are tag names and values are (positive) priority boosts
   *   for tasks/markers possessing that tag.  The Map must *not* be mutated
   *   after it is passed-in.  (We could be defensive about this, but all our
   *   callers should be in-GELAM so it shouldn't be hard to comply.)
   */
  setPriorityBoostTags: function(owningId, tagsWithValues) {
    // This is a 2-pass implementation:
    // 1) Accumulate per-task/marker priority deltas stored in a map.
    // 2) Apply those deltas to the priority heap.
    // We don't want to update the heap as we go because

    let existingValues = this._priorityTagsByOwner.get(owningId) || new Map();
    let newValues = tagsWithValues || new Map();
    let perThingDeltas = new Map();

    let summedPriorityTags = this._summedPriorityTags;
    let priorityTagToHeapNodes = this._priorityTagToHeapNodes;

    if (tagsWithValues) {
      this._priorityTagsByOwner.set(owningId, tagsWithValues);
    } else {
      this._priorityTagsByOwner.delete(owningId);
    }

    // -- Phase 1: accumulate deltas (and update sums)
    let applyDelta = (priorityTag, delta) => {
      // - update sum
      let newSum = (summedPriorityTags.get(priorityTag) || 0) + delta;
      if (newSum) {
        summedPriorityTags.set(priorityTag, newSum);
      } else {
        summedPriorityTags.delete(priorityTag);
      }

      // - per-taskthing deltas
      let nodes = priorityTagToHeapNodes.get(priorityTag);
      if (nodes) {
        for (let node of nodes) {
          let aggregateDelta = (perThingDeltas.get(node) || 0) + delta;
          perThingDeltas.set(node, aggregateDelta);
        }
      }
    };

    // - Iterate over newValues for new/changed values.
    for (let [priorityTag, newPriority] of newValues.items()) {
      let oldPriority = existingValues.get(priorityTag) || 0;
      let priorityDelta = newPriority - oldPriority;
      applyDelta(priorityTag, priorityDelta);
    }
    // - Iterate over existingValues for deletions
    for (let [priorityTag, oldPriority] of existingValues.items()) {
      if (newValues.has(priorityTag)) {
        continue;
      }
      applyDelta(priorityTag, -oldPriority);
    }

    // -- Phase 2: update the priority heap
    for (let [node, aggregateDelta] of perThingDeltas.values()) {
      // The heap allows us to reduce keys (Which, because we negate them, means
      // priority increases) efficiently, but otherwise we need to remove the
      // thing and re-add it.
      let newKey = node.key - aggregateDelta; // (the keys are negated!)
      this._reprioritizeHeapNode(node, newKey);
    }
  },

  /**
   * Wrap raw tasks and issue them an id, suitable for persisting to the
   * database.
   */
  __wrapTasks: function(rawTasks) {
    return rawTasks.map((rawTask) => {
      return {
        id: this._nextId++,
        rawTask: rawTask,
        state: null // => planned => (deleted)
      };
    });
  },

  /**
   * Enqueue the given tasks for planning now that they have been persisted to
   * disk.
   */
  __enqueuePersistedTasksForPlanning: function(wrappedTasks) {
    this._tasksToPlan.splice(this._tasksToPlan.length, 0, ...wrappedTasks);
    this._maybeDoStuff();
  },

  /**
   * If we have any task planning or task executing to do.
   *
   * XXX as a baby-steps simplification, right now we only do one of these at a
   * time.  We *absolutely* do not want to be doing this forever.
   */
  _maybeDoStuff: function() {
    if (this._activePromise) {
      return;
    }

    if (this._tasksToPlan.length) {
      this._activePromise = this._planNextTask();
    } else if (!this._prioritizedTasks.isEmpty()) {
      this._activePromise = this._executeNextTask();
    } else {
      logic(this, 'nothingToDo');
    }

    if (!this._activePromise) {
      return;
    }

    this._activePromise.then(() => {
      this._activePromise = null;
      this._maybeDoStuff();
    }, (err) => {
      this._activePromise = null;
      logic(this, 'taskError', { err: err, stack: err.stack });
      this._maybeDoStuff();
    });
  },

  /**
   * Plan the next task.  This task will advance to 'planned' atomically as part
   * of the completion of planning.  In the case of simple tasks, this will
   * happen via a call to `__prioritizeTask`, but for complex tasks other stuff
   * may happen.
   */
  _planNextTask: function() {
    let wrappedTask = this._tasksToPlan.shift();
    logic(this, 'planning:begin', { task: wrappedTask });
    let ctx = new TaskContext(wrappedTask, this._universe);
    let planResult = this._registry.planTask(ctx, wrappedTask);
    if (planResult) {
      planResult.then(() => {
        logic(this, 'planning:end', { task: wrappedTask });
        this.emit('planned:' + wrappedTask.id);
      });
    } else {
      logic(this, 'planning:end', { moot: true, task: wrappedTask });
      this.emit('planned:' + wrappedTask.id);
    }
    return planResult;
  },

  /**
   * Helper to decide whether to use decreaseKey for a node or remove it and
   * re-add it.  Centralized because this seems easy to screw up.  All values
   * are in the key-space, which is just the negated priority.
   */
  _reprioritizeHeapNode: function(node, newKey) {
    let prioritizedTasks = this._prioritizedTasks;
    if (newKey < node.key) {
      prioritizedTasks.decreaseKey(node, newKey);
    } else if (newKey > node.key) {
      let taskThing = node.value;
      prioritizedTasks.delete(node);
      prioritizedTasks.insert(newKey, taskThing);
    } // we intentionally do nothing for a delta of 0
  },

  _prioritizeTasksOrMarkers: function(tasksOrThings) {
    for (let i = 0; i < tasksOrThings.length; i++) {
      this.__prioritizeTaskOrMarker(tasksOrThings[i]);
    }
  },

  /**
   * Called by `TaskContext` when a task completes being planned.
   *
   * @param {WrappedTask|TaskMarker} taskThing
   */
  __prioritizeTaskOrMarker: function(taskThing, sourceId, noTrigger) {
    logic(this, 'prioritizing', { taskOrMarker: taskThing, sourceId });

    // WrappedTasks store the type on the plannedTask; TaskMarkers store it on
    // the root (they're simple/flat).
    let isTask = !taskThing.type;
    let priorityTags = isTask ? taskThing.plannedTask.priorityTags
                              : taskThing.priorityTags;
    let relPriority = (isTask ? taskThing.plannedTask.relPriority
                              : taskThing.relPriority) || 0;
    let priority = relPriority + this._computePriorityForTags(priorityTags);
    // it's a minheap, we negate keys
    let nodeKey = -priority;

    if (!isTask) {
      // There may already exist a node for this in the map, in which case we
      // need to
      let priorityNode = this._markerIdToHeapNode.get(taskThing.id);
      if (priorityNode) {
        this._reprioritizeHeapNode(priorityNode, nodeKey);
      } else {
        priorityNode =
          this._prioritizedTasks.insert(nodeKey, taskThing);
        this._markerIdToHeapNode.set(taskThing.id, priorityNode);
      }
    } else {
      this._prioritizedTasks.insert(nodeKey, taskThing);
      // (this isn't a marker so we don't put an entry in
      // _markerIdToHeapNode)
    }

    // If nothing is happening, then we might need/want to call _maybeDoStuff
    // soon, but not until whatever's calling us has had a chance to finish.
    // And if something is happening, well, we already know we will call
    // _maybeDoStuff when that happens.  (Note that we must not call
    // _maybeDoStuff synchronously because _maybeDoStuff may already be on the
    // stack, waiting for a promise to be returned to it.)
    // XXX Audit this more and potentially ensure there's only one of these
    // nextTick-style hacks.  But right now this should be harmless but
    // wasteful.
    if (!noTrigger && !this._activePromise) {
      Promise.resolve().then(() => {
        this._maybeDoStuff();
      });
    }
  },

  /**
   * Remove the task marker with the given id.
   */
  __removeMarker: function(markerId) {
    let priorityNode = this._markerIdToHeapNode.get(markerId);
    if (priorityNode) {
      this._prioritizedTasks.delete(priorityNode);
      this._markerIdToHeapNode.delete(markerId);
      logic(this, 'removeMarker', { id: markerId });
    }
  },

  _executeNextTask: function() {
    let taskThing = this._prioritizedTasks.extractMinimum().value;
    let isTask = !taskThing.type;
    logic(this, 'executing:begin', { task: taskThing });

    // If this is a marker, remove it from the heap node or it will leak.
    if (!isTask) {
      this._markerIdToHeapNode.delete(taskThing.id);
    }
    let ctx = new TaskContext(taskThing, this._universe);
    let execResult = this._registry.executeTask(ctx, taskThing);
    if (execResult) {
      execResult.then(() => {
        logic(this, 'executing:end', { task: taskThing });
        this.emit('executed:' + taskThing.id);
      });
    } else {
      logic(this, 'executing:end', { moot: true, task: taskThing });
      this.emit('executed:' + taskThing.id);
    }
    return execResult;
  }
});

return TaskManager;
});

define(function(require) {
'use strict';

const logic = require('logic');

/**
 * Tracks the set of known tasks, both global and per-account-type, and manages
 * the global and per-account-instance instances for all cases.  It:
 * - Gets told the global and per-account-type task implementations
 * - Gets told what account id's exist and their account type, so that it can...
 * - Create/restore the complex state instances as appropriate.
 * - Deciding which task implementation is appropriate for a given task.  This
 *   primarily happens on the basis of accountId if the task type was not in
 *   the global registry.
 */
function TaskRegistry({ dataOverlayManager }) {
  logic.defineScope(this, 'TaskRegistry');

  this._dataOverlayManager = dataOverlayManager;

  this._globalTasks = new Map();
  this._globalTaskRegistry = new Map();
  this._perAccountTypeTasks = new Map();
  this._perAccountIdTaskRegistry = new Map();

  this._dbDataByAccount = new Map();
}
TaskRegistry.prototype = {
  registerGlobalTasks: function(taskImpls) {
    for (let taskImpl of taskImpls) {
      this._globalTasks.set(taskImpl.name, taskImpl);
      // currently all global tasks must be simple
      if (taskImpl.isComplex) {
        throw new Error('hey, no complex global tasks yet!');
      }
      this._globalTaskRegistry.set(
        taskImpl.name,
        {
          impl: taskImpl,
          persistent: null,
          transient: null
        });
    }
  },

  /**
   * Indicates whether tasks have been registered for the given account type
   * yet.
   */
  isAccountTypeKnown: function(accountType) {
    return this._perAccountTypeTasks.has(accountType);
  },

  registerPerAccountTypeTasks: function(accountType, taskImpls) {
    let perTypeTasks = this._perAccountTypeTasks.get(accountType);
    if (!perTypeTasks) {
      perTypeTasks = new Map();
      this._perAccountTypeTasks.set(accountType, perTypeTasks);
    }

    for (let taskImpl of taskImpls) {
      perTypeTasks.set(taskImpl.name, taskImpl);
    }
  },

  /**
   * The loaded complex task states which we stash until we hear about the
   * account existing with `accountExists`.
   */
  initializeFromDatabaseState: function([stateKeys, stateValues]) {
    if (stateKeys.length !== stateValues.length) {
      throw new Error('impossible complex state inconsistency issue');
    }
    for (let i = 0; i < stateKeys.length; i++) {
      let [accountId, taskType, taskKey] = stateKeys[i];
      let value = stateValues[i];
      // NB: The data we receive from IndexedDB has a known ordering that could
      // allow this loop to avoid wasted Map lookups, although it's unlikely
      // to ever matter.

      // - Binned by account
      let dataByTaskType = this._dbDataByAccount.get(accountId);
      if (!dataByTaskType) {
        dataByTaskType = new Map();
        this._dbDataByAccount.set(accountId, dataByTaskType);
      }

      // - Binned by task type
      // Is this a multi-valued Map?
      if (taskKey !== undefined) {
        // Multi-valued Map stored as multiple keyed records
        let map = dataByTaskType.get(taskType);
        if (!map) {
          map = new Map();
          dataByTaskType.set(taskType, map);
        }
        map.set(taskKey, value);
      } else {
        // Single object, no key.
        dataByTaskType.set(taskType, value);
      }
    }
  },

  /**
   * Given a complex task implementation bound to an account (which is tracked
   * in a taskMeta dict), find methods named like "overlay_NAMESPACE", and
   * dynamically register them with the `DataOverlayManager`.
   *
   * We currently do not support unregistering which is consistent with other
   * simplifications we've made like this.  We would implement all of that at
   * the same time.
   */
  _registerComplexTaskImplWithDataOverlayManager: function(accountId, meta) {
    let taskImpl = meta.impl;

    // (Tasks are strictly mix-in based and do not use the prototype chain.
    // Obviously, if this changes, this traversal needs to change.)
    for (let key of Object.keys(taskImpl)) {
      let overlayMatch = /^overlay_(.+)$/.exec(key);
      if (overlayMatch) {
        logic(
          this, 'registerOverlayProvider',
          {
            accountId,
            taskName: taskImpl.name,
            overlayType: overlayMatch[1]
          });
        this._dataOverlayManager.registerProvider(
          overlayMatch[1],
          taskImpl.name,
          taskImpl[key].bind(
            taskImpl,
            meta.persistentState,
            meta.memoryState)
        );
      }
    }
  },

  /**
   * Initialize the per-account per-task-type data structures for a given
   * account.  While ideally many complex tasks can synchronously initialize
   * themselves, some may be async and may return a promise.  For that reason,
   * this method is async.
   */
  accountExistsInitTasks: function(accountId, accountType) {
    logic(this, 'accountExistsInitTasks', { accountId, accountType });
    // Get the implementations known for this account type
    let taskImpls = this._perAccountTypeTasks.get(accountType);
    if (!taskImpls) {
      logic(this, 'noPerAccountTypeTasks', { accountId, accountType });
    }

    let accountMarkers = [];
    let pendingPromises = [];

    // Get any pre-existing state for the account
    let dataByTaskType = this._dbDataByAccount.get(accountId);
    if (!dataByTaskType) {
      dataByTaskType = new Map();
    }

    // Populate the { impl, persistent, transient } instances keyed by task type
    let taskMetas = new Map();
    this._perAccountIdTaskRegistry.set(accountId, taskMetas);

    for (let unlatchedTaskImpl of taskImpls.values()) {
      let taskImpl = unlatchedTaskImpl; // (let limitations in gecko right now)
      let taskType = taskImpl.name;
      let meta = {
        impl: taskImpl,
        persistentState: dataByTaskType.get(taskType),
        memoryState: null
      };
      if (taskImpl.isComplex) {
        logic(
          this, 'initializingComplexTask',
          { accountId, taskType, hasPersistentState: !!meta.persistentState });
        if (!meta.persistentState) {
          meta.persistentState = taskImpl.initPersistentState();
        }
        // Invoke the complex task's real init logic that may need to do some
        // async db stuff if its state isn't in the persistent state we
        // helpfully loaded.
        let maybePromise =
          taskImpl.deriveMemoryStateFromPersistentState(meta.persistentState,
                                                        accountId);
        let saveOffMemoryState = ({ memoryState, markers }) => {
          meta.memoryState = memoryState;
          if (markers) {
            // markers may be an iterator so concat is not safe (at least it
            // bugged on gecko as of writing this), so use push/spread.
            accountMarkers.push(...markers);
          }

          this._registerComplexTaskImplWithDataOverlayManager(accountId, meta);
        };
        if (maybePromise.then) {
          pendingPromises.push(maybePromise.then(saveOffMemoryState));
        } else {
          saveOffMemoryState(maybePromise);
        }
      }

      taskMetas.set(taskType, meta);
    }

    return Promise.all(pendingPromises).then(() => {
      return accountMarkers;
    });
  },

  accountRemoved: function(/*accountId*/) {
    // TODO: properly handle and propagate account removal
  },

  planTask: function(ctx, wrappedTask) {
    let rawTask = wrappedTask.rawTask;
    let taskType = rawTask.type;
    let taskMeta;
    if (this._globalTaskRegistry.has(taskType)) {
      taskMeta = this._globalTaskRegistry.get(taskType);
    } else {
      let accountId = rawTask.accountId;
      let perAccountTasks = this._perAccountIdTaskRegistry.get(accountId);
      if (!perAccountTasks) {
        // This means the account is no longer known to us.  Return immediately,
        return null;
      }
      taskMeta = perAccountTasks.get(taskType);
      if (!taskMeta) {
        logic(this, 'noSuchTaskProvider', { taskType, accountId });
        return null;
      }
    }

    ctx.__taskInstance = taskMeta.impl;
    let maybePromiseResult;
    try {
      if (taskMeta.impl.isComplex) {
        maybePromiseResult = taskMeta.impl.plan(
          ctx, taskMeta.persistentState, taskMeta.memoryState, rawTask);
      } else {
        // All tasks have a plan stage.  Even if it's only the default one that
        // just chucks it in the priority bucket.
        return taskMeta.impl.plan(ctx, rawTask);
      }
    } catch (ex) {
      logic.fail(ex);
    }
    // We need to force tasks to finalize if they don't do so themselves.  This
    // is true for both rejections and returns without finalization.
    if (maybePromiseResult.then) {
      let doFinalize = () => { ctx.__failsafeFinalize(); };
      // I'm intentionally not forcing the return to wait on the failsafe
      // finalization to happen out of paranoia.  It might be a good idea,
      // though.
      maybePromiseResult.then(doFinalize, doFinalize);
    } else {
      ctx.__failsafeFinalize();
    }
    return maybePromiseResult;
  },

  executeTask: function(ctx, taskThing) {
    let isMarker = !!taskThing.type;
    let taskType = isMarker ? taskThing.type : taskThing.plannedTask.type;
    let taskMeta;
    if (this._globalTaskRegistry.has(taskType)) {
      taskMeta = this._globalTaskRegistry.get(taskType);
    } else {
      let accountId = isMarker ? taskThing.accountId
                               : taskThing.plannedTask.accountId;
      taskMeta = this._perAccountIdTaskRegistry.get(accountId).get(taskType);
    }

    if (!taskMeta.impl.execute) {
      return Promise.resolve();
    }

    if (isMarker !== taskMeta.impl.isComplex) {
      throw new Error('Trying to exec ' + taskType + ' but isComplex:' +
                       taskMeta.impl.isComplex);
    }

    ctx.__taskInstance = taskMeta.impl;
    if (isMarker) {
      return taskMeta.impl.execute(
        ctx, taskMeta.persistentState, taskMeta.memoryState, taskThing);
    } else {
      return taskMeta.impl.execute(ctx, taskThing.plannedTask);
    }
  },

  __synchronouslyConsultOtherTask: function(ctx, consultWhat, argDict) {
    let taskType = consultWhat.name;
    let taskMeta;
    if (this._globalTaskRegistry.has(taskType)) {
      taskMeta = this._globalTaskRegistry.get(taskType);
    } else {
      let accountId = consultWhat.accountId;
      taskMeta = this._perAccountIdTaskRegistry.get(accountId).get(taskType);
    }

    if (!taskMeta.impl.consult) {
      throw new Error('implementation has no consult method');
    }

    return taskMeta.impl.consult(
      ctx, taskMeta.persistentState, taskMeta.memoryState, argDict);
  },
};

return TaskRegistry;
});

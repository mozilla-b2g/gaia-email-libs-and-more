define(function(require) {
'use strict';

let logic = require('logic');

/**
 * Tracks the set of known tasks, both global and per-account-type, and manages
 * the global and per-account-instance instances for all cases.  It:
 * - Gets told the global and per-account-type task implementations
 * - Gets told what account id's exist and their account type, so that it can...
 * - Create/restore the complex state instances as appropriate.
 * - Deciding which task implementation is appropriate for a given task.  This
 *   primarily happens on the basis of accountId if the task type was not in
 *   the global registry.
 *
 * @param {MailDB} db
 *   Database reference to pass through to complex tasks during their
 *   initialization.
 */
function TaskRegistry(db) {
  logic.defineScope(this, 'TaskRegistry');
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
      this._globalTaskRegistry.set(
        taskImpl.name,
        {
          impl: taskImpl,
          persistent: null,
          transient: null
        });
    }
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
  initializeFromDatabaseState: function(complexStates) {
    for (let rec of complexStates) {
      let [accountId, taskType] = rec.key;
      let dataByTaskType = this._dbDataByAccount.get(accountId);
      if (!dataByTaskType) {
        dataByTaskType = new Map();
        this._dbDataByAccount.set(accountId, dataByTaskType);
      }
      dataByTaskType.set(taskType, rec);
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
        persistent: dataByTaskType.get(taskType),
        transient: null
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
            accountMarkers = accountMarkers.concat(markers);
          }
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

  accountRemoved: function(accountId) {
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

    if (taskMeta.impl.isComplex) {
      return taskMeta.impl.plan(
        ctx, taskMeta.persistentState, taskMeta.memoryState, rawTask);
    } else {
      // All tasks have a plan stage.  Even if it's only the default one that
      // just chucks it in the priority bucket.
      return taskMeta.impl.plan(ctx, rawTask);
    }
  },

  executeTask: function(ctx, taskThing) {
    let isTask = !taskThing.type;
    let taskType = isTask ? taskThing.plannedTask.type : taskThing.type;
    let taskMeta;
    if (this._globalTaskRegistry.has(taskType)) {
      taskMeta = this._globalTaskRegistry.get(taskType);
    } else {
      let accountId = isTask ? taskThing.plannedTask.accountId
                             : taskThing.accountId;
      taskMeta = this._perAccountIdTaskRegistry.get(accountId).get(taskType);
    }

    if (!taskMeta.impl.execute) {
      return Promise.resolve();
    }

    if (isTask === taskMeta.impl.isComplex) {
      throw new Error('Complex task executions consume markers not tasks.');
    }

    if (isTask) {
      return taskMeta.impl.execute(ctx, taskThing.plannedTask);
    } else {
      return taskMeta.impl.execute(
        ctx, taskMeta.persistentState, taskMeta.memoryState, taskThing);
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

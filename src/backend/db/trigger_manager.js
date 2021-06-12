import logic from 'logic';

/**
 * Simple mechanism for triggers to specify modifications to make that are bound
 * to their instance that can perform logging so that when things go wrong it
 * isn't a big mystery.  Also the mechanism for us to provide additional context
 * in which the trigger is being invoked that we don't want to have to push
 * as arguments.
 *
 * This could be thought of as a baby version of tasks' TaskContext.
 */
function TriggerContext(triggerManager, triggerName) {
  this._triggerManager = triggerManager;
  this.name = triggerName;
}
TriggerContext.prototype = {
  /**
   * @see Taskcontext.rootTaskGroupId
   */
  get rootTaskGroupId() {
    return this._triggerManager.sourceTaskContext.rootTaskGroupId;
  },

  /**
   * @param {Object} [dict.atomicDeltas]
   * @param {Object} [dict.atomicDeltas.accounts]
   * @param {Object} [dict.atomicDeltas.folders]
   * @param {Object} [dict.atomicClobbers]
   * @param {Object|Map} [dict.atomicClobbers.config]
   * @param {Object|Map} [dict.atomicClobbers.accounts]
   * @param {Object|Map} [dict.atomicClobbers.folders]
   * @param {Map} [dict.complexTaskStates]
   * @param {RawTask} [dict.rootGroupDeferredTask]
   *   A task to schedule when the root task group that this task belongs to
   *   completes.  Try and reuse object instances when possible to enable
   *   de-duplication as requests are added, if possible.  Note that currently
   *   this is the only way for a trigger to cause a task to be scheduled,
   *   although it is a goal and we should have an enhancement to explicitly
   *   allow adding tasks here.
   */
  modify(dict) {
    return this._triggerManager.__triggerMutate(this.name, dict);
  }
};

/**
 * Helps the trigger implementations be clean and have a chance of being
 * understood and debugged.  Specifically, it:
 * - Registers the declarative triggers with the MailDB using on.  (The trigger
 *   implementation just describes what it wants to listen on.)
 * - Does bind magic so that the first argument to each trigger is an automagic
 *   helper that is the means of the trigger having a side-effect.  This allows
 *   us to optionally crank up the debug if we want, or just be lazy and
 *   simple.  We have the trigger call a method rather than just returning a
 *   value because triggers will usually not have to do anything, etc.
 *
 * TODO: either expose logging in here or in MailDB.
 */
export default function TriggerManager({ db, triggers }) {
  logic.defineScope(this, 'TriggerManager');
  this.db = db;
  db.triggerManager = this;

  /**
   * @type {Array}
   * The MailDB clobbers an array onto us into which triggers can push mutation
   * dictionaries with `atomicClobber` and `atomicDelta` fields can be present.
   * The actual manipulation of this is done in a bound _triggerMutate.
   *
   * We have the MailDB directly mutate us for improved visibility of this
   * mechanism versus using emit.
   */
  this.derivedMutations = null;
  this.sourceTaskContext = null;

  for (let trigger of triggers) {
    this.registerTriggerDictionary(trigger);
  }
}
TriggerManager.prototype = {
  /**
   * MailDB calls this to provide us for context during the (synchronous,
   * non-control-flow yielding) mutation logic steps during which time triggers
   * will fire.  It will call __clearState when done.
   *
   * MailDB invokes us directly for implementation clarity versus emit and also
   * because we don't really want any other mechanisms duplicating how we work.
   */
  __setState(taskContext, derivedMutations) {
    this.sourceTaskContext = taskContext;
    this.derivedMutations = derivedMutations;
  },

  __clearState() {
    this.sourceTaskContext = null;
    this.derivedMutations = null;
  },

  __triggerMutate(triggerName, dict) {
    logic(this, 'triggerMutate', { triggerName, dict });
    if (this.derivedMutations) {
      this.derivedMutations.push(dict);
    }
  },

  /**
   * Register a trigger dictionary.  See our class doc-block for more details.
   *
   * There's no unregister method right now.  Triggers check in, but they don't
   * check out.
   */
  registerTriggerDictionary(triggerDef) {
    let triggerName = triggerDef.name;
    let triggerContext = new TriggerContext(this, triggerName);

    for (let key of Object.keys(triggerDef)) {
      switch (key) {
        // Ignore special metadata fields.
        case 'name':
          break;
        // Everything else is something to bind.
        default: {
          let handlerFunc = triggerDef[key];
          if (!handlerFunc || !handlerFunc.bind) {
            throw new Error(`${triggerName} has broken handler '${key}: ${handlerFunc}`);
          }
          let boundHandler = handlerFunc.bind(null, triggerContext);
          this.db.on(key, boundHandler);
        }
      }
    }
  },

  /**
   * Register a single function as a trigger handler; intended to be used by
   * the TaskRegistry to allow task instances to do trigger-like things.
   */
  registerTriggerFunc(eventName, triggerName, handlerFunc) {
    let triggerContext = new TriggerContext(this, triggerName);
    let boundHandler = handlerFunc.bind(null, triggerContext);
    this.db.on(eventName, boundHandler);
  }
};

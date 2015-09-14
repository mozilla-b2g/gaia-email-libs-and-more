define(function() {
'use strict';

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
function TriggerManager({ db, triggers }) {
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

  for (let trigger of triggers) {
    this.registerTrigger(trigger);
  }
}
TriggerManager.prototype = {
  _triggerMutate: function(triggerName, dict) {
    if (this.derivedMutations) {
      this.derivedMutations.push(dict);
    }
  },

  /**
   * Register a trigger.  See our class doc-block for more details.
   *
   * There's no unregister method right now.  Triggers check in, but they don't
   * check out.
   */
  registerTrigger: function(triggerDef) {
    let triggerName = triggerDef.name;
    for (let key of Object.keys(triggerDef)) {
      switch (key) {
        // Ignore special metadata fields.
        case 'name':
          break;
        // Everything else is something to bind.
        default:
          let handlerFunc = triggerDef[key];
          let triggerMutate = this._triggerMutate.bind(this, triggerName);
          let boundHandler = handlerFunc.bind(null, triggerMutate);
          this.db.on(key, boundHandler);
      }
    }
  },
};
return TriggerManager;
});

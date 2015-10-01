define(function() {
'use strict';

const co = require('co');

// (this is broken out into a helper for clarity and to avoid temporary gecko
// "let" issues.)
const makeWrappedOverlayFunc = function(helpedOverlayFunc) {
  return function(persistentState, memoryState, id) {
    return helpedOverlayFunc.call(
      this,
      id,
      persistentState.binToMarker.get(id),
      memoryState.inProgressBins.has(id));
  };
};

/**
 * See `TaskDefiner.defineAtMostOnceTask` for a consumer view and high-level
 * overview.  We are implementation details.
 *
 * ## State Management ##
 *
 * Our markers are logically the same as that of a planned task.
 */
return {
  isSimple: false,
  isComplex: true,

  /**
   * Generate helper "overlay_" functions based on the functions we find on the
   * mixed aggregate provided to the define*Task call.
   */
  __preMix: function(mixedSource) {
    for (let key of Object.keys(mixedSource)) {
      let overlayMatch = /^helped_overlay_(.+)$/.exec(key);
      if (overlayMatch) {
        let overlayType = overlayMatch[1];

        this['overlay_' + overlayType] =
          makeWrappedOverlayFunc(mixedSource[key]);
      }
    }
  },

  /**
   * Markers are added to persistent state as they are planned, and only removed
   * when the execute task completes.
   */
  initPersistentState: function() {
    return {
      binToMarker: new Map()
    };
  },

  /**
   * Our memory state tracks the bins that are actively being processed.  This
   * is done for data overlay purposes so we can track what is being processed.
   */
  deriveMemoryStateFromPersistentState: function(persistentState, accountId) {
    return {
      memoryState: {
        accountId,
        inProgressBins: new Set()
      },
      markers: persistentState.binToMarker.values()
    };
  },

  /**
   * Checks if an existing task already exists.  If it does, we do nothing other
   * than (someday) doing root cause id bookkeeping stuff.  Otherwise we invoke
   * the helped_plan method and repurpose its taskState to be our marker.  It's
   * on the helped_plan implementation to generate
   */
  plan: co.wrap(function*(ctx, persistentState, memoryState, req) {
    let binId = req[this.binByArg];

    // - Fast-path out if the bin is already planned.
    if (persistentState.binToMarker.has(binId)) {
      yield ctx.finishTask({});
      return undefined;
    }

    let rval = yield this.helped_plan(ctx, req);
    // If there is no new state, we do not need to generate a marker.
    if (rval.taskState) {
      // Derive the mark from the taskState, but clobbering our stuff on top to
      // avoid worst-case breakage.
      let marker = Object.assign(
        {},
        rval.taskState,
        {
          type: this.name,
          id: this.name + ':' + binId,
          accountId: memoryState.accountId,
        });
      rval.taskMarkers = new Map([[marker.id, marker]]);
      persistentState.binToMarker.set(binId, marker);
      rval.complexTaskState = persistentState;

      // The TaskContext doesn't actually know whether we're complex or not,
      // so we need to clobber this to be null to indicate that it should close
      // out the task.
      rval.taskState = null;
    }

    // The helped_plan implementation needs to tell us to do the announcement
    // for it since the persistentState will not be updated until after it
    // returns.  (Although could dangerously/incorrectly try and depend on the
    // behaviour of the batch manager and assumptions our internal contro flow.)
    if (rval.announceUpdatedOverlayData) {
      for (let [namespace, id] of rval.announceUpdatedOverlayData) {
        ctx.announceUpdatedOverlayData(namespace, id);
      }
    }

    yield ctx.finishTask(rval);
    return rval.result;
  }),

  execute: co.wrap(function*(ctx, persistentState, memoryState, marker) {
    let binId = marker[this.binByArg];
    memoryState.inProgressBins.add(binId);

    let rval = yield this.helped_execute(ctx, marker);

    memoryState.inProgressBins.delete(binId);
    persistentState.binToMarker.delete(binId);
    rval.complexTaskState = persistentState;

    // The helped_execute implementation needs to tell us to do the announcement
    // for it since the persistentState will not be updated until after it
    // returns.  (Although could dangerously/incorrectly try and depend on the
    // behaviour of the batch manager and assumptions our internal contro flow.)
    if (rval.announceUpdatedOverlayData) {
      for (let [namespace, id] of rval.announceUpdatedOverlayData) {
        ctx.announceUpdatedOverlayData(namespace, id);
      }
    }

    yield ctx.finishTask(rval);
    return rval.result;
  })
};
});

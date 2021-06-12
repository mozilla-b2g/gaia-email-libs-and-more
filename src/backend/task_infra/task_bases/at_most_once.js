import logic from 'logic';

// (this is broken out into a helper for clarity and to avoid temporary gecko
// "let" issues.)
const makeWrappedOverlayFunc = function(helpedOverlayFunc) {
  return function(persistentState, memoryState, blockedTaskChecker, id) {
    return helpedOverlayFunc.call(
      this,
      id,
      persistentState.binToMarker.get(id),
      memoryState.inProgressBins.has(id) ||
        memoryState.remainInProgressBins.has(id),
      blockedTaskChecker(this.name + ':' + id));
  };
};

const makeWrappedPrefixOverlayFunc = function([extractor, helpedOverlayFunc]) {
  return function(persistentState, memoryState, blockedTaskChecker, fullId) {
    // use the provided extractor to get the id for the bin.
    let binId = extractor(fullId);
    return helpedOverlayFunc.call(
      this,
      fullId,
      binId,
      persistentState.binToMarker.get(binId),
      memoryState.inProgressBins.has(binId) ||
        memoryState.remainInProgressBins.has(binId),
      blockedTaskChecker(this.name + ':' + binId));
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
export default {
  isSimple: false,
  isComplex: true,

  /**
   * Generate helper "overlay_" functions based on the functions we find on the
   * mixed aggregate provided to the define*Task call.
   */
  __preMix(mixedSource) {
    for (let key of Object.keys(mixedSource)) {
      let overlayMatch = /^helped_overlay_(.+)$/.exec(key);
      if (overlayMatch) {
        let overlayType = overlayMatch[1];

        this['overlay_' + overlayType] =
          makeWrappedOverlayFunc(mixedSource[key]);
      }

      let prefixedOverlayMatch = /^helped_prefix_overlay_(.+)$/.exec(key);
      if (prefixedOverlayMatch) {
        let overlayType = prefixedOverlayMatch[1];

        this['overlay_' + overlayType] =
          makeWrappedPrefixOverlayFunc(mixedSource[key]);
      }
    }
  },

  /**
   * Markers are added to persistent state as they are planned, and only removed
   * when the execute task completes.
   */
  initPersistentState() {
    return {
      binToMarker: new Map()
    };
  },

  /**
   * Our memory state tracks the bins that are actively being processed.  This
   * is done for data overlay purposes so we can track what is being processed.
   */
  deriveMemoryStateFromPersistentState(persistentState, accountId) {
    return {
      memoryState: {
        accountId,
        inProgressBins: new Set(),
        remainInProgressBins: new Set()
      },
      markers: persistentState.binToMarker.values()
    };
  },

  /**
   * Checks if an existing task already exists.  If it does, we do nothing other
   * than (someday) doing root cause id bookkeeping stuff.  Otherwise we invoke
   * the helped_plan method and repurpose its taskState to be our marker.  It's
   * on the helped_plan implementation to generate.
   */
  async plan(ctx, persistentState, memoryState, req) {
    let binId = this.binByArg ? req[this.binByArg] : 'only';

    // - Fast-path out if the bin is already planned.
    if (persistentState.binToMarker.has(binId)) {
      let rval;
      if (this.helped_already_planned) {
        logic(ctx, 'alreadyPlanned');
        rval = await this.helped_already_planned(ctx, req);
      } else {
        rval = {};
      }
      await ctx.finishTask(rval);
      return ctx.returnValue(rval.result);
    }

    let rval = await this.helped_plan(ctx, req);
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

    if (rval.remainInProgressUntil &&
        this.helped_invalidate_overlays) {
      memoryState.remainInProgressBins.add(binId);
      let dataOverlayManager = ctx.universe.dataOverlayManager;
      rval.remainInProgressUntil.then(() => {
        memoryState.remainInProgressBins.delete(binId);
        this.helped_invalidate_overlays(binId, dataOverlayManager);
      });
    }

    if (this.helped_invalidate_overlays) {
      this.helped_invalidate_overlays(binId, ctx.universe.dataOverlayManager);
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

    await ctx.finishTask(rval);

    return ctx.returnValue(rval.result);
  },

  async execute(ctx, persistentState, memoryState, marker) {
    let binId = this.binByArg ? marker[this.binByArg] : 'only';
    memoryState.inProgressBins.add(binId);

    if (this.helped_invalidate_overlays) {
      this.helped_invalidate_overlays(binId, ctx.universe.dataOverlayManager);
    }

    let rval = await this.helped_execute(ctx, marker);

    memoryState.inProgressBins.delete(binId);
    persistentState.binToMarker.delete(binId);
    rval.complexTaskState = persistentState;

    if (this.helped_invalidate_overlays) {
      this.helped_invalidate_overlays(binId, ctx.universe.dataOverlayManager);
    }
    // The helped_execute implementation needs to tell us to do the announcement
    // for it since the persistentState will not be updated until after it
    // returns.  (Although could dangerously/incorrectly try and depend on the
    // behaviour of the batch manager and assumptions our internal contro flow.)
    if (rval.announceUpdatedOverlayData) {
      for (let [namespace, id] of rval.announceUpdatedOverlayData) {
        ctx.announceUpdatedOverlayData(namespace, id);
      }
    }

    await ctx.finishTask(rval);
    return ctx.returnValue(rval.result);
  },
};

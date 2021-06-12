import logic from 'logic';

import { TransformStream, WritableStream, CountQueuingStrategy } from 'streams';
import { shallowClone } from 'shared/util';

/**
 * The filtering stream is fed TOC change events consisting of
 * add/change/remove and generates appropriate add/change/remove events based
 * on the results of filtering.
 *
 * The gather stream is an asynchronous processing queue that uses streams under
 * the hood in order to intelligently pipeline to avoid being impacted by
 * underlying I/O or transit latencies.
 *
 * The model is that the id's/namers go in one end an object including the
 * expanded representation come out the other end.  (There are similarities to
 * GraphQL's model, so maybe in the future if we end up with fancier needs,
 * some portion of such an implementation would work here.)
 *
 * For example, we might have the input { convId } with a gather-spec of
 * { conversation, message: { bodyContents } }.  We end up needing to perform
 * two gather steps for each conversation Id.  In step one we fetch the
 * ConversationInfo and array of MessageInfo objects for each conversation.  In
 * step two we run the body gatherer over each message.  The resulting gathered
 * object then looks like:
 *
 *     {
 *       conversation: {},
 *       messages: [
 *         { message, bodyContents }
 *       ]
 *     }
 *
 * @param {}
 */
export default function FilteringStream({ ctx, filterRunner, rootGatherer,
    preDerivers, postDerivers,
    isDeletion, inputToGatherInto, mutateChangeToResembleAdd,
    mutateChangeToResembleDeletion, onFilteredUpdate }) {
  // Implementation-wise this ends up slightly weird.  Our gathering transform
  // stream returns Promises that will be resolved with the actual gathered
  // object representation.  This is necessary because the current transform
  // stream implementation only allows for one outstanding

  /**
   * The id's of items currently in the processing queue for consideration.
   * The intent is that if an item A is added that will match, but is removed
   * prior to being reported, that we can avoid ever reporting A.  This is not
   * so much an optimization as a suspicious error-avoidance mechanism. We do
   * not want to report anything to consumers that is already known to be moot.
   * Noisy error logs are ignored error logs.
   */
  const queuedSet = new Set();
  /**
   * The id's of all items that have been reported as filter matches.  Our
   * contract with TOCs is that we only tell them about removals for things we
   * have told them exist, so this is absolutely necessary.  (This is also good
   * from an efficiency perspective since the deletion has to flow through the
   * stream for consistency/sanity purposes, and that has a memory cost.  Also,
   * the TOC maintains an ordered array which is O(log N) to check, so that
   * would be bad that way too.
   */
  const knownFilteredSet = new Set();

  const notifyAdded = (deriverList, gathered) => {
    for (let deriver of deriverList) {
      deriver.itemAdded(gathered);
    }
  };

  const notifyRemoved = (deriverList, id) => {
    for (let deriver of deriverList) {
      deriver.itemRemoved(id);
    }
  };

  /**
   * Stream that allows us to keep some number of gathers in flight for pipeline
   * throughput optimization.  This stream takes in the change requests that
   * contain the id we need to gather and immediately returns a Promise.  This
   * allows us to get the requests in flight despite the transform stream only
   * allowing for one active transform at a time.  The filter stream in turn
   * then waits for the promises in its transform stage since it has a direct
   * data dependency and we do want to maintain ordering.
   */
  const gatherStream = new TransformStream({
    flush(enqueue, close) {
      close();
    },
    transform(change, enqueue, done) {
      if (isDeletion(change)) {
        enqueue({ change, gather: null });
      } else {
        // (avoid gathering data for already-removed items)
        if (queuedSet.has(change.id)) {
          logic(ctx, 'gathering', { id: change.id });
          let gatherInto = inputToGatherInto(change);
          enqueue({ change, gather: rootGatherer.gather(gatherInto) });
        }
      }
      done();
    },
    writableStrategy: new CountQueuingStrategy({ highWaterMark: 1 }),
    readableStrategy: new CountQueuingStrategy({ highWaterMark: 1 })
  });

  const filterStream = new TransformStream({
    flush(enqueue, close) {
      close();
    },
    transform({ change, gather }, enqueue, done) {
      if (!gather) {
        // This is a deletion.  And we care about it or we wouldn't be here.
        enqueue(change);
        notifyRemoved(preDerivers, change.id);
        if (knownFilteredSet.delete(change.id)) {
          notifyRemoved(postDerivers, change.id);
        }
        done();
      } else {
        logic(ctx, 'gatherWait', { id: change.id });
        gather.then((gathered) => {
          logic(ctx, 'gathered', { id: change.id });
          // It's possible the item got removed after we kicked off the gather.
          // Don't report the item in that case.  (Note that explicit deletion
          // of things already reported triggered the first branch of this if,
          // so we don't need to be worrying about that here.)
          if (!queuedSet.has(change.id)) {
            logic(ctx, 'notInQueuedSet');
            done();
            return;
          }
          queuedSet.delete(change.id);
          notifyAdded(preDerivers, gathered);
          let matchInfo = filterRunner.filter(gathered);
          logic(ctx, 'maybeMatch', { matched: !!matchInfo });
          if (matchInfo) {
            // - Match!
            // We need to much with the change from here on out, so we need to
            // make our own mutable copy.
            change = shallowClone(change);
            // We match now, we may or may not have previously matched.
            if (!knownFilteredSet.has(change.id)) {
              // Didn't have it before, have it now.  Make sure this resembles
              // an add.  (If this actually is an add, this is a no-op.)
              mutateChangeToResembleAdd(change);
              knownFilteredSet.add(change.id);
              notifyAdded(postDerivers, gathered);
            }
            // And this is how the matchInfo actually gets into the TOC...
            change.matchInfo = matchInfo;
            enqueue(change);
          } else {
            // - No Match!
            // We may need to issue a retraction... delete and check RV.
            if (knownFilteredSet.delete(change.id)) {
              change = shallowClone(change);
              mutateChangeToResembleDeletion(change);
              enqueue(change);
              notifyRemoved(postDerivers, change.id);
            }
          }
          done();
        });
      }
    },
    writableStrategy: new CountQueuingStrategy({ highWaterMark: 1 }),
    readableStrategy: new CountQueuingStrategy({ highWaterMark: 1 })
  });

  //bufferingStream.readable.pipeTo(gatherStream.writable);
  gatherStream.readable.pipeThrough(filterStream).pipeTo(new WritableStream({
    start() {
    },
    write(change) {
      onFilteredUpdate(change);
    },
    close() {
      // I don't think anything actually cares?  Unless we should be propagating
      // through to the moot callback?
    },
    abort(ex) {
      logic(ctx, 'filteringStreamAbortError', { ex, stack: ex.stack });
    }
  }, new CountQueuingStrategy({ highWaterMark: 1 })));

  return {
    /**
     * This is how we are fed data/changes from the database.
     */
    consider: (change) => {
      if (!isDeletion(change)) {
        // - add/change, process for filtering
        queuedSet.add(change.id);
        gatherStream.writable.write(change);
      } else {
        // - removal
        queuedSet.delete(change.id);
        // If the item was already reported, however, we do need to propagate
        // this through, however.
        if (knownFilteredSet.has(change.id)) {
          gatherStream.writable.write(change);
        } else {
          notifyRemoved(preDerivers, change.id);
          // postDerivers never heard about it since knownFilteredSet doesn't
          // include it.
        }
      }
    },
    destroy: () => {
      gatherStream.writable.close();
    }
  };
}

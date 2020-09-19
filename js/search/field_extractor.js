/**
 * Perform simple assumed safe object attribute traversals while also
 * potentially accumulating a map of aggregate values.
 */
export default function FieldExtractor({ extract, aggregate }) {
  const extractOps = this._extractOps = [];
  const aggrOps = this._aggregateOps = [];
  const aggregated = this.aggregated = {};

  for (let key of Object.keys(extract)) {
    // This is where we would do any static sanitizing to ensure crazy things
    // aren't being requested.  We might also do a one-off test traversal using
    // hasOwnPropery and maybe some type checking the first time we are invoked,
    // but it's not clear what the threat model would be yet since we won't
    // invoke methods and only methods can do destructive stuff.
    extractOps.push({
      key,
      traversal: extract[key]
    });
  }

  if (aggregate) {
    for (let unlatchedKey of Object.keys(aggregate)) {
      const key = unlatchedKey; // XXX spidermonkey is still deficient.
      const { op: aggrOp, field: traversal, initial } = aggregate[key];
      aggregated[key] = initial;
      switch (aggrOp) {
        case 'max': {
          aggrOps.push({
            merger: (val) => {
              aggregated[key] = Math.max(aggregated[key], val);
            },
            traversal
          });
          break;
        }

        default: {
          throw new Error('bad aggregate op: ' + aggrOp);
        }
      }
    }
  }
}
FieldExtractor.prototype = {
  _traverse(rootObj, traversal ) {
    let curObj = rootObj;
    try {
      for (let attr of traversal) {
        curObj = curObj[attr];
      }
    } catch (ex) {
      curObj = null;
    }
    return curObj;
  },

  extract(gathered, idName, idValue) {
    const extracted = {
      [idName]: idValue
    };
    for (let { key, traversal } of this._extractOps) {
      extracted[key] = this._traverse(gathered, traversal);
    }

    for (let { merger, traversal } of this._aggregateOps) {
      merger(this._traverse(gathered, traversal));
    }

    return extracted;
  }
};

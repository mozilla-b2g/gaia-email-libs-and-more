export default function NestedGatherer(rootKey, rootGatherer) {
  this.rootKey = rootKey;
  this.rootGatherer = rootGatherer;
  this.gatherers = new Map();
}
NestedGatherer.prototype = {
  nested: true,

  hasGatherer: function(key) {
    return this.gatherers.has(key) || key === this.rootKey;
  },

  getGatherer: function(key) {
    return this.gatherers.get(key);
  },

  addGatherer: function(key, gatherer) {
    this.gatherers.set(key, gatherer);
  },

  makeNestedGatherer: function(key, rootKey, rootGatherer) {
    let nestedGatherer = new NestedGatherer(rootKey, rootGatherer);
    this.gatherers.set(key, nestedGatherer);
    return nestedGatherer;
  },

  _gatherChildren: function(gatherInto) {
    let allPromises = [];
    for (let [ukey, ugatherer] of this.gatherers.entries()) {
      // gr, latching bugs still exist in SpiderMonkey apparently, so manually
      // latch here.
      let key = ukey;
      let gatherer = ugatherer;
      // It's possible for our caller to have been clever and already
      // pre-populated some stuff for us.  In that case, skip this gatherer as
      // long as it's not nested.  The nested case will handle the root being
      // present automatically.
      if (gatherInto[key] && !gatherer.nested) {
        continue;
      }
      let promise = gatherer.gather(gatherInto);
      allPromises.push(promise.then((value) => {
        gatherInto[key] = value;
      }));
    }
    return Promise.all(allPromises).then(() => {
      return gatherInto;
    });
  },

  gather: function(gathered) {
    if (this.rootGatherer) {
      let rootGather;
      // Allow bypassing the gatherer if the thing is already
      if (gathered[this.rootKey]) {
        rootGather = Promise.resolve(gathered[this.rootKey]);
      } else {
        rootGather = this.rootGatherer.gather(gathered);
      }
      return rootGather.then((rootResult) => {
        if (this.rootGatherer.plural) {
          // Plural, so the result is an array and we want to create a context
          // for each item and then run a gather on each of those items.
          let childPromises = [];
          let pluralGathers = rootResult.map((item) => {
            let childGather = {
              [this.rootKey]: item
            };
            childPromises.push(this._gatherChildren(childGather));
            return childGather;
          });
          // And we want to wait for those all to complete, at which point we
          // can return our array of gather contexts for our parent to integrate
          // stuff into.
          return Promise.all(childPromises).then(() => {
            return pluralGathers;
          });
        } else {
          // Non-plural, so give the nested value its own context which gets
          // populated with the root key and then gather into that.
          let subGather = {
            [this.rootKey]: rootResult
          };
          return this._gatherChildren(subGather);
        }
      });
    } else {
      return this._gatherChildren(gathered);
    }
  }
};

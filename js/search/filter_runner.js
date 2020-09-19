/**
 * Give it filters, it figures out how to efficiently run them, and then when
 * you ask it to filter something, it filters it for you and returns a nicely
 * constructed MatchInfo structure.
 *
 * NB: Figuring out how to efficiently run them just means sorting them so
 * that we run cheap ones before more expensive ones.  And this assumes that the
 * filters don't need to be run anyways to provide useful boolean or snippet
 * indicators.
 */
export default function FilterRunner({ filters }) {
  this.filters = filters.concat();
  // Sort the filters in order of ascending cost.
  this.filters.sort((a, b) => {
    return a.cost - b.cost;
  });
}
FilterRunner.prototype = {
  filter(gathered) {
    let matchInfo = {};
    let matched = this.filters.length === 0;
    for (let filter of this.filters) {
      let matchDetails = null;
      if (!matched || filter.alwaysRun) {
        matchDetails = filter.test(gathered);
        if (matchDetails) {
          matched = true;
        }
      }
      matchInfo[filter.resultKey] = matchDetails;
    }
    if (matched) {
      return matchInfo;
    } else {
      return null;
    }
  }
};

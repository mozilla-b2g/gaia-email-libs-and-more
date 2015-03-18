define(function(require) {

/**
 * Coordinates IMAP usage so that we can run things faster, unambigously
 * pipeline things, avoid gratuitous folder-switching, etc.  The fundamental
 * idea is that callers don't need to know or care about connection usage.  They
 * just care about results.
 *
 * For mutations or other things where there are side-effects from our calls,
 * return values are always defined to disambiguate as well as the caller could
 * given the same information (and without establishing new connections.)
 */
function ParallelIMAP() {
  
}
ParallelIMAP.prototype = {

};

return ParallelIMAP;
});

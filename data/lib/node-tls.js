/**
 *
 **/

define(
  [
    'net',
    'exports'
  ],
  function(
    $net,
    exports
  ) {

exports.connect = function(port, host, wuh, onconnect) {
  var socky = new $net.NetSocket(port, host, true);
  socky.on('connect', onconnect);
  return socky;
};

}); // end define

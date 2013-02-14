/*
 * Pulls together all the activesync code, used as a delayed load build
 * layer.
 */

define(
  [
    'activesync/protocol',
    './activesync/account',
    'exports'
  ],
  function(
    $asproto,
    $asacct,
    exports
  ) {

exports.asproto = $asproto;
exports.asacct = $asacct;

}); // end define

define(
  [
    'exports'
  ],
  function(
    exports
  ) {

exports.setTimeout = window.setTimeout.bind(window);
exports.setInterval = window.setInterval.bind(window);
exports.clearTimeout = window.clearTimeout.bind(window);
exports.clearInterval = window.clearInterval.bind(window);

}); // end define

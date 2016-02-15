/**
 * This module ends up being loader/builder-specific.  This file is a
 * demonstration of using RequireJS/Alameda to instantiate the worker.
 **/
define(function(require, exports, module) {
'use strict';

return function makeWorker() {
  var appLogicPath = module.config().appLogicPath;
  var workerUrl =
    require.toUrl('gelam/worker_bootstrap.js') +
    '#appLogic=' + encodeURIComponent(appLogicPath);
  return new Worker(workerUrl);
};
});

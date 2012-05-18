/*
 * We just want RequireJS to use the load() command.  Happily, RequireJS is
 * extensible, and we can follow the lead of the r.js node adapter.
 */

var _LOAD_SPACES = '                                                         ';
require.load = function(context, moduleName, url) {
  context.scriptCount += 1;

  print('LOAD', moduleName,
        _LOAD_SPACES.substring(0, 40 - moduleName.length), 'from', url); // extra spaces
  load(url);

  context.completeLoad(moduleName);
  return undefined;
};

// synchronous load!
// this bit is direct from RequireJS, taken under the MIT license, why not.
require.get = function(context, moduleName, relModuleMap) {
  if (moduleName === "require" || moduleName === "exports" || moduleName === "module") {
    require.onError(new Error("Explicit require of " + moduleName + " is not allowed."));
  }

  var ret,
  moduleMap = context.makeModuleMap(moduleName, relModuleMap);

  //Normalize module name, if it contains . or ..
  moduleName = moduleMap.fullName;

  if (moduleName in context.defined) {
    ret = context.defined[moduleName];
  } else {
    if (ret === undefined) {
      //Try to dynamically fetch it.
      require.load(context, moduleName, moduleMap.url);
      //The above call is sync, so can do the next thing safely.
      ret = context.defined[moduleName];
    }
  }

  return ret;
};

require.onError = function(err) {
  console.error('RequireJS Error in', err.moduleName, '\n', err, '\n',
                err.stack);
};

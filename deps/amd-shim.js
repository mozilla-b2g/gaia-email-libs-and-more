var define;
(function () {
  var modules = {};
  define = function (id, deps, fn) {
    if (typeof deps === 'function') {
        fn = deps;
        deps = null;
    }

    if (deps) {
      deps = deps.map(function (dep) {
        if (dep.charAt(0) === '.') {
          dep = 'mailapi' + dep.substring(1);
        }
        if (dep === 'exports') {
          return modules[id] = {};
        } else {
          return modules[dep];
        }
      });
    }
    var result = fn.apply(modules[id], deps);
    if (!modules[id]) {
      modules[id] = result;
    }
  };
}());

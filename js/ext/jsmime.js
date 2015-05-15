'use strict';

/**
 * Copyright (c) 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * https://raw.github.com/facebook/regenerator/master/LICENSE file. An
 * additional grant of patent rights can be found in the PATENTS file in
 * the same directory.
 */

!(function(global) {
  "use strict";

  var hasOwn = Object.prototype.hasOwnProperty;
  var undefined; // More compressible than void 0.
  var iteratorSymbol =
    typeof Symbol === "function" && Symbol.iterator || "@@iterator";

  var inModule = typeof module === "object";
  var runtime = global.regeneratorRuntime;
  if (runtime) {
    if (inModule) {
      // If regeneratorRuntime is defined globally and we're in a module,
      // make the exports object identical to regeneratorRuntime.
      module.exports = runtime;
    }
    // Don't bother evaluating the rest of this file if the runtime was
    // already defined globally.
    return;
  }

  // Define the runtime globally (as expected by generated code) as either
  // module.exports (if we're in a module) or a new, empty object.
  runtime = global.regeneratorRuntime = inModule ? module.exports : {};

  function wrap(innerFn, outerFn, self, tryLocsList) {
    // If outerFn provided, then outerFn.prototype instanceof Generator.
    var generator = Object.create((outerFn || Generator).prototype);

    generator._invoke = makeInvokeMethod(
      innerFn, self || null,
      new Context(tryLocsList || [])
    );

    return generator;
  }
  runtime.wrap = wrap;

  // Try/catch helper to minimize deoptimizations. Returns a completion
  // record like context.tryEntries[i].completion. This interface could
  // have been (and was previously) designed to take a closure to be
  // invoked without arguments, but in all the cases we care about we
  // already have an existing method we want to call, so there's no need
  // to create a new function object. We can even get away with assuming
  // the method takes exactly one argument, since that happens to be true
  // in every case, so we don't have to touch the arguments object. The
  // only additional allocation required is the completion record, which
  // has a stable shape and so hopefully should be cheap to allocate.
  function tryCatch(fn, obj, arg) {
    try {
      return { type: "normal", arg: fn.call(obj, arg) };
    } catch (err) {
      return { type: "throw", arg: err };
    }
  }

  var GenStateSuspendedStart = "suspendedStart";
  var GenStateSuspendedYield = "suspendedYield";
  var GenStateExecuting = "executing";
  var GenStateCompleted = "completed";

  // Returning this object from the innerFn has the same effect as
  // breaking out of the dispatch switch statement.
  var ContinueSentinel = {};

  // Dummy constructor functions that we use as the .constructor and
  // .constructor.prototype properties for functions that return Generator
  // objects. For full spec compliance, you may wish to configure your
  // minifier not to mangle the names of these two functions.
  function Generator() {}
  function GeneratorFunction() {}
  function GeneratorFunctionPrototype() {}

  var Gp = GeneratorFunctionPrototype.prototype = Generator.prototype;
  GeneratorFunction.prototype = Gp.constructor = GeneratorFunctionPrototype;
  GeneratorFunctionPrototype.constructor = GeneratorFunction;
  GeneratorFunction.displayName = "GeneratorFunction";

  // Helper for defining the .next, .throw, and .return methods of the
  // Iterator interface in terms of a single ._invoke method.
  function defineIteratorMethods(prototype) {
    ["next", "throw", "return"].forEach(function(method) {
      prototype[method] = function(arg) {
        return this._invoke(method, arg);
      };
    });
  }

  runtime.isGeneratorFunction = function(genFun) {
    var ctor = typeof genFun === "function" && genFun.constructor;
    return ctor
      ? ctor === GeneratorFunction ||
        // For the native GeneratorFunction constructor, the best we can
        // do is to check its .name property.
        (ctor.displayName || ctor.name) === "GeneratorFunction"
      : false;
  };

  runtime.mark = function(genFun) {
    genFun.__proto__ = GeneratorFunctionPrototype;
    genFun.prototype = Object.create(Gp);
    return genFun;
  };

  // Within the body of any async function, `await x` is transformed to
  // `yield regeneratorRuntime.awrap(x)`, so that the runtime can test
  // `value instanceof AwaitArgument` to determine if the yielded value is
  // meant to be awaited. Some may consider the name of this method too
  // cutesy, but they are curmudgeons.
  runtime.awrap = function(arg) {
    return new AwaitArgument(arg);
  };

  function AwaitArgument(arg) {
    this.arg = arg;
  }

  function AsyncIterator(generator) {
    // This invoke function is written in a style that assumes some
    // calling function (or Promise) will handle exceptions.
    function invoke(method, arg) {
      var result = generator[method](arg);
      var value = result.value;
      return value instanceof AwaitArgument
        ? Promise.resolve(value.arg).then(invokeNext, invokeThrow)
        : Promise.resolve(value).then(function(unwrapped) {
            // When a yielded Promise is resolved, its final value becomes
            // the .value of the Promise<{value,done}> result for the
            // current iteration. If the Promise is rejected, however, the
            // result for this iteration will be rejected with the same
            // reason. Note that rejections of yielded Promises are not
            // thrown back into the generator function, as is the case
            // when an awaited Promise is rejected. This difference in
            // behavior between yield and await is important, because it
            // allows the consumer to decide what to do with the yielded
            // rejection (swallow it and continue, manually .throw it back
            // into the generator, abandon iteration, whatever). With
            // await, by contrast, there is no opportunity to examine the
            // rejection reason outside the generator function, so the
            // only option is to throw it from the await expression, and
            // let the generator function handle the exception.
            result.value = unwrapped;
            return result;
          });
    }

    if (typeof process === "object" && process.domain) {
      invoke = process.domain.bind(invoke);
    }

    var invokeNext = invoke.bind(generator, "next");
    var invokeThrow = invoke.bind(generator, "throw");
    var invokeReturn = invoke.bind(generator, "return");
    var previousPromise;

    function enqueue(method, arg) {
      var enqueueResult =
        // If enqueue has been called before, then we want to wait until
        // all previous Promises have been resolved before calling invoke,
        // so that results are always delivered in the correct order. If
        // enqueue has not been called before, then it is important to
        // call invoke immediately, without waiting on a callback to fire,
        // so that the async generator function has the opportunity to do
        // any necessary setup in a predictable way. This predictability
        // is why the Promise constructor synchronously invokes its
        // executor callback, and why async functions synchronously
        // execute code before the first await. Since we implement simple
        // async functions in terms of async generators, it is especially
        // important to get this right, even though it requires care.
        previousPromise ? previousPromise.then(function() {
          return invoke(method, arg);
        }) : new Promise(function(resolve) {
          resolve(invoke(method, arg));
        });

      // Avoid propagating enqueueResult failures to Promises returned by
      // later invocations of the iterator.
      previousPromise = enqueueResult["catch"](function(ignored){});

      return enqueueResult;
    }

    // Define the unified helper method that is used to implement .next,
    // .throw, and .return (see defineIteratorMethods).
    this._invoke = enqueue;
  }

  defineIteratorMethods(AsyncIterator.prototype);

  // Note that simple async functions are implemented on top of
  // AsyncIterator objects; they just return a Promise for the value of
  // the final result produced by the iterator.
  runtime.async = function(innerFn, outerFn, self, tryLocsList) {
    var iter = new AsyncIterator(
      wrap(innerFn, outerFn, self, tryLocsList)
    );

    return runtime.isGeneratorFunction(outerFn)
      ? iter // If outerFn is a generator, return the full iterator.
      : iter.next().then(function(result) {
          return result.done ? result.value : iter.next();
        });
  };

  function makeInvokeMethod(innerFn, self, context) {
    var state = GenStateSuspendedStart;

    return function invoke(method, arg) {
      if (state === GenStateExecuting) {
        throw new Error("Generator is already running");
      }

      if (state === GenStateCompleted) {
        if (method === "throw") {
          throw arg;
        }

        // Be forgiving, per 25.3.3.3.3 of the spec:
        // https://people.mozilla.org/~jorendorff/es6-draft.html#sec-generatorresume
        return doneResult();
      }

      while (true) {
        var delegate = context.delegate;
        if (delegate) {
          if (method === "return" ||
              (method === "throw" && delegate.iterator[method] === undefined)) {
            // A return or throw (when the delegate iterator has no throw
            // method) always terminates the yield* loop.
            context.delegate = null;

            // If the delegate iterator has a return method, give it a
            // chance to clean up.
            var returnMethod = delegate.iterator["return"];
            if (returnMethod) {
              var record = tryCatch(returnMethod, delegate.iterator, arg);
              if (record.type === "throw") {
                // If the return method threw an exception, let that
                // exception prevail over the original return or throw.
                method = "throw";
                arg = record.arg;
                continue;
              }
            }

            if (method === "return") {
              // Continue with the outer return, now that the delegate
              // iterator has been terminated.
              continue;
            }
          }

          var record = tryCatch(
            delegate.iterator[method],
            delegate.iterator,
            arg
          );

          if (record.type === "throw") {
            context.delegate = null;

            // Like returning generator.throw(uncaught), but without the
            // overhead of an extra function call.
            method = "throw";
            arg = record.arg;
            continue;
          }

          // Delegate generator ran and handled its own exceptions so
          // regardless of what the method was, we continue as if it is
          // "next" with an undefined arg.
          method = "next";
          arg = undefined;

          var info = record.arg;
          if (info.done) {
            context[delegate.resultName] = info.value;
            context.next = delegate.nextLoc;
          } else {
            state = GenStateSuspendedYield;
            return info;
          }

          context.delegate = null;
        }

        if (method === "next") {
          if (state === GenStateSuspendedYield) {
            context.sent = arg;
          } else {
            context.sent = undefined;
          }

        } else if (method === "throw") {
          if (state === GenStateSuspendedStart) {
            state = GenStateCompleted;
            throw arg;
          }

          if (context.dispatchException(arg)) {
            // If the dispatched exception was caught by a catch block,
            // then let that catch block handle the exception normally.
            method = "next";
            arg = undefined;
          }

        } else if (method === "return") {
          context.abrupt("return", arg);
        }

        state = GenStateExecuting;

        var record = tryCatch(innerFn, self, context);
        if (record.type === "normal") {
          // If an exception is thrown from innerFn, we leave state ===
          // GenStateExecuting and loop back for another invocation.
          state = context.done
            ? GenStateCompleted
            : GenStateSuspendedYield;

          var info = {
            value: record.arg,
            done: context.done
          };

          if (record.arg === ContinueSentinel) {
            if (context.delegate && method === "next") {
              // Deliberately forget the last sent value so that we don't
              // accidentally pass it on to the delegate.
              arg = undefined;
            }
          } else {
            return info;
          }

        } else if (record.type === "throw") {
          state = GenStateCompleted;
          // Dispatch the exception by looping back around to the
          // context.dispatchException(arg) call above.
          method = "throw";
          arg = record.arg;
        }
      }
    };
  }

  // Define Generator.prototype.{next,throw,return} in terms of the
  // unified ._invoke helper method.
  defineIteratorMethods(Gp);

  Gp[iteratorSymbol] = function() {
    return this;
  };

  Gp.toString = function() {
    return "[object Generator]";
  };

  function pushTryEntry(locs) {
    var entry = { tryLoc: locs[0] };

    if (1 in locs) {
      entry.catchLoc = locs[1];
    }

    if (2 in locs) {
      entry.finallyLoc = locs[2];
      entry.afterLoc = locs[3];
    }

    this.tryEntries.push(entry);
  }

  function resetTryEntry(entry) {
    var record = entry.completion || {};
    record.type = "normal";
    delete record.arg;
    entry.completion = record;
  }

  function Context(tryLocsList) {
    // The root entry object (effectively a try statement without a catch
    // or a finally block) gives us a place to store values thrown from
    // locations where there is no enclosing try statement.
    this.tryEntries = [{ tryLoc: "root" }];
    tryLocsList.forEach(pushTryEntry, this);
    this.reset(true);
  }

  runtime.keys = function(object) {
    var keys = [];
    for (var key in object) {
      keys.push(key);
    }
    keys.reverse();

    // Rather than returning an object with a next method, we keep
    // things simple and return the next function itself.
    return function next() {
      while (keys.length) {
        var key = keys.pop();
        if (key in object) {
          next.value = key;
          next.done = false;
          return next;
        }
      }

      // To avoid creating an additional object, we just hang the .value
      // and .done properties off the next function object itself. This
      // also ensures that the minifier will not anonymize the function.
      next.done = true;
      return next;
    };
  };

  function values(iterable) {
    if (iterable) {
      var iteratorMethod = iterable[iteratorSymbol];
      if (iteratorMethod) {
        return iteratorMethod.call(iterable);
      }

      if (typeof iterable.next === "function") {
        return iterable;
      }

      if (!isNaN(iterable.length)) {
        var i = -1, next = function next() {
          while (++i < iterable.length) {
            if (hasOwn.call(iterable, i)) {
              next.value = iterable[i];
              next.done = false;
              return next;
            }
          }

          next.value = undefined;
          next.done = true;

          return next;
        };

        return next.next = next;
      }
    }

    // Return an iterator with no values.
    return { next: doneResult };
  }
  runtime.values = values;

  function doneResult() {
    return { value: undefined, done: true };
  }

  Context.prototype = {
    constructor: Context,

    reset: function(skipTempReset) {
      this.prev = 0;
      this.next = 0;
      this.sent = undefined;
      this.done = false;
      this.delegate = null;

      this.tryEntries.forEach(resetTryEntry);

      if (!skipTempReset) {
        for (var name in this) {
          // Not sure about the optimal order of these conditions:
          if (name.charAt(0) === "t" &&
              hasOwn.call(this, name) &&
              !isNaN(+name.slice(1))) {
            this[name] = undefined;
          }
        }
      }
    },

    stop: function() {
      this.done = true;

      var rootEntry = this.tryEntries[0];
      var rootRecord = rootEntry.completion;
      if (rootRecord.type === "throw") {
        throw rootRecord.arg;
      }

      return this.rval;
    },

    dispatchException: function(exception) {
      if (this.done) {
        throw exception;
      }

      var context = this;
      function handle(loc, caught) {
        record.type = "throw";
        record.arg = exception;
        context.next = loc;
        return !!caught;
      }

      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        var record = entry.completion;

        if (entry.tryLoc === "root") {
          // Exception thrown outside of any try block that could handle
          // it, so set the completion value of the entire function to
          // throw the exception.
          return handle("end");
        }

        if (entry.tryLoc <= this.prev) {
          var hasCatch = hasOwn.call(entry, "catchLoc");
          var hasFinally = hasOwn.call(entry, "finallyLoc");

          if (hasCatch && hasFinally) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            } else if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }

          } else if (hasCatch) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            }

          } else if (hasFinally) {
            if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }

          } else {
            throw new Error("try statement without catch or finally");
          }
        }
      }
    },

    abrupt: function(type, arg) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc <= this.prev &&
            hasOwn.call(entry, "finallyLoc") &&
            this.prev < entry.finallyLoc) {
          var finallyEntry = entry;
          break;
        }
      }

      if (finallyEntry &&
          (type === "break" ||
           type === "continue") &&
          finallyEntry.tryLoc <= arg &&
          arg <= finallyEntry.finallyLoc) {
        // Ignore the finally entry if control is not jumping to a
        // location outside the try/catch block.
        finallyEntry = null;
      }

      var record = finallyEntry ? finallyEntry.completion : {};
      record.type = type;
      record.arg = arg;

      if (finallyEntry) {
        this.next = finallyEntry.finallyLoc;
      } else {
        this.complete(record);
      }

      return ContinueSentinel;
    },

    complete: function(record, afterLoc) {
      if (record.type === "throw") {
        throw record.arg;
      }

      if (record.type === "break" ||
          record.type === "continue") {
        this.next = record.arg;
      } else if (record.type === "return") {
        this.rval = record.arg;
        this.next = "end";
      } else if (record.type === "normal" && afterLoc) {
        this.next = afterLoc;
      }
    },

    finish: function(finallyLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.finallyLoc === finallyLoc) {
          this.complete(entry.completion, entry.afterLoc);
          resetTryEntry(entry);
          return ContinueSentinel;
        }
      }
    },

    "catch": function(tryLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc === tryLoc) {
          var record = entry.completion;
          if (record.type === "throw") {
            var thrown = record.arg;
            resetTryEntry(entry);
          }
          return thrown;
        }
      }

      // The context.catch method must only be called with a location
      // argument that corresponds to a known catch block.
      throw new Error("illegal catch attempt");
    },

    delegateYield: function(iterable, resultName, nextLoc) {
      this.delegate = {
        iterator: values(iterable),
        resultName: resultName,
        nextLoc: nextLoc
      };

      return ContinueSentinel;
    }
  };
})(
  // Among the various tricks for obtaining a reference to the global
  // object, this seems to be the most reliable technique that does not
  // use indirect eval (which violates Content Security Policy).
  typeof global === "object" ? global :
  typeof window === "object" ? window :
  typeof self === "object" ? self : this
);


"use strict";

/**
 * Copyright (c) 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * https://raw.github.com/facebook/regenerator/master/LICENSE file. An
 * additional grant of patent rights can be found in the PATENTS file in
 * the same directory.
 */

!(function (global) {
  "use strict";

  var hasOwn = Object.prototype.hasOwnProperty;
  var undefined; // More compressible than void 0.
  var iteratorSymbol = typeof Symbol === "function" && Symbol.iterator || "@@iterator";

  var inModule = typeof module === "object";
  var runtime = global.regeneratorRuntime;
  if (runtime) {
    if (inModule) {
      // If regeneratorRuntime is defined globally and we're in a module,
      // make the exports object identical to regeneratorRuntime.
      module.exports = runtime;
    }
    // Don't bother evaluating the rest of this file if the runtime was
    // already defined globally.
    return;
  }

  // Define the runtime globally (as expected by generated code) as either
  // module.exports (if we're in a module) or a new, empty object.
  runtime = global.regeneratorRuntime = inModule ? module.exports : {};

  function wrap(innerFn, outerFn, self, tryLocsList) {
    // If outerFn provided, then outerFn.prototype instanceof Generator.
    var generator = Object.create((outerFn || Generator).prototype);

    generator._invoke = makeInvokeMethod(innerFn, self || null, new Context(tryLocsList || []));

    return generator;
  }
  runtime.wrap = wrap;

  // Try/catch helper to minimize deoptimizations. Returns a completion
  // record like context.tryEntries[i].completion. This interface could
  // have been (and was previously) designed to take a closure to be
  // invoked without arguments, but in all the cases we care about we
  // already have an existing method we want to call, so there's no need
  // to create a new function object. We can even get away with assuming
  // the method takes exactly one argument, since that happens to be true
  // in every case, so we don't have to touch the arguments object. The
  // only additional allocation required is the completion record, which
  // has a stable shape and so hopefully should be cheap to allocate.
  function tryCatch(fn, obj, arg) {
    try {
      return { type: "normal", arg: fn.call(obj, arg) };
    } catch (err) {
      return { type: "throw", arg: err };
    }
  }

  var GenStateSuspendedStart = "suspendedStart";
  var GenStateSuspendedYield = "suspendedYield";
  var GenStateExecuting = "executing";
  var GenStateCompleted = "completed";

  // Returning this object from the innerFn has the same effect as
  // breaking out of the dispatch switch statement.
  var ContinueSentinel = {};

  // Dummy constructor functions that we use as the .constructor and
  // .constructor.prototype properties for functions that return Generator
  // objects. For full spec compliance, you may wish to configure your
  // minifier not to mangle the names of these two functions.
  function Generator() {}
  function GeneratorFunction() {}
  function GeneratorFunctionPrototype() {}

  var Gp = GeneratorFunctionPrototype.prototype = Generator.prototype;
  GeneratorFunction.prototype = Gp.constructor = GeneratorFunctionPrototype;
  GeneratorFunctionPrototype.constructor = GeneratorFunction;
  GeneratorFunction.displayName = "GeneratorFunction";

  // Helper for defining the .next, .throw, and .return methods of the
  // Iterator interface in terms of a single ._invoke method.
  function defineIteratorMethods(prototype) {
    ["next", "throw", "return"].forEach(function (method) {
      prototype[method] = function (arg) {
        return this._invoke(method, arg);
      };
    });
  }

  runtime.isGeneratorFunction = function (genFun) {
    var ctor = typeof genFun === "function" && genFun.constructor;
    return ctor ? ctor === GeneratorFunction ||
    // For the native GeneratorFunction constructor, the best we can
    // do is to check its .name property.
    (ctor.displayName || ctor.name) === "GeneratorFunction" : false;
  };

  runtime.mark = function (genFun) {
    genFun.__proto__ = GeneratorFunctionPrototype;
    genFun.prototype = Object.create(Gp);
    return genFun;
  };

  // Within the body of any async function, `await x` is transformed to
  // `yield regeneratorRuntime.awrap(x)`, so that the runtime can test
  // `value instanceof AwaitArgument` to determine if the yielded value is
  // meant to be awaited. Some may consider the name of this method too
  // cutesy, but they are curmudgeons.
  runtime.awrap = function (arg) {
    return new AwaitArgument(arg);
  };

  function AwaitArgument(arg) {
    this.arg = arg;
  }

  function AsyncIterator(generator) {
    // This invoke function is written in a style that assumes some
    // calling function (or Promise) will handle exceptions.
    function invoke(method, arg) {
      var result = generator[method](arg);
      var value = result.value;
      return value instanceof AwaitArgument ? Promise.resolve(value.arg).then(invokeNext, invokeThrow) : Promise.resolve(value).then(function (unwrapped) {
        // When a yielded Promise is resolved, its final value becomes
        // the .value of the Promise<{value,done}> result for the
        // current iteration. If the Promise is rejected, however, the
        // result for this iteration will be rejected with the same
        // reason. Note that rejections of yielded Promises are not
        // thrown back into the generator function, as is the case
        // when an awaited Promise is rejected. This difference in
        // behavior between yield and await is important, because it
        // allows the consumer to decide what to do with the yielded
        // rejection (swallow it and continue, manually .throw it back
        // into the generator, abandon iteration, whatever). With
        // await, by contrast, there is no opportunity to examine the
        // rejection reason outside the generator function, so the
        // only option is to throw it from the await expression, and
        // let the generator function handle the exception.
        result.value = unwrapped;
        return result;
      });
    }

    if (typeof process === "object" && process.domain) {
      invoke = process.domain.bind(invoke);
    }

    var invokeNext = invoke.bind(generator, "next");
    var invokeThrow = invoke.bind(generator, "throw");
    var invokeReturn = invoke.bind(generator, "return");
    var previousPromise;

    function enqueue(method, arg) {
      var enqueueResult =
      // If enqueue has been called before, then we want to wait until
      // all previous Promises have been resolved before calling invoke,
      // so that results are always delivered in the correct order. If
      // enqueue has not been called before, then it is important to
      // call invoke immediately, without waiting on a callback to fire,
      // so that the async generator function has the opportunity to do
      // any necessary setup in a predictable way. This predictability
      // is why the Promise constructor synchronously invokes its
      // executor callback, and why async functions synchronously
      // execute code before the first await. Since we implement simple
      // async functions in terms of async generators, it is especially
      // important to get this right, even though it requires care.
      previousPromise ? previousPromise.then(function () {
        return invoke(method, arg);
      }) : new Promise(function (resolve) {
        resolve(invoke(method, arg));
      });

      // Avoid propagating enqueueResult failures to Promises returned by
      // later invocations of the iterator.
      previousPromise = enqueueResult["catch"](function (ignored) {});

      return enqueueResult;
    }

    // Define the unified helper method that is used to implement .next,
    // .throw, and .return (see defineIteratorMethods).
    this._invoke = enqueue;
  }

  defineIteratorMethods(AsyncIterator.prototype);

  // Note that simple async functions are implemented on top of
  // AsyncIterator objects; they just return a Promise for the value of
  // the final result produced by the iterator.
  runtime.async = function (innerFn, outerFn, self, tryLocsList) {
    var iter = new AsyncIterator(wrap(innerFn, outerFn, self, tryLocsList));

    return runtime.isGeneratorFunction(outerFn) ? iter // If outerFn is a generator, return the full iterator.
    : iter.next().then(function (result) {
      return result.done ? result.value : iter.next();
    });
  };

  function makeInvokeMethod(innerFn, self, context) {
    var state = GenStateSuspendedStart;

    return function invoke(method, arg) {
      if (state === GenStateExecuting) {
        throw new Error("Generator is already running");
      }

      if (state === GenStateCompleted) {
        if (method === "throw") {
          throw arg;
        }

        // Be forgiving, per 25.3.3.3.3 of the spec:
        // https://people.mozilla.org/~jorendorff/es6-draft.html#sec-generatorresume
        return doneResult();
      }

      while (true) {
        var delegate = context.delegate;
        if (delegate) {
          if (method === "return" || method === "throw" && delegate.iterator[method] === undefined) {
            // A return or throw (when the delegate iterator has no throw
            // method) always terminates the yield* loop.
            context.delegate = null;

            // If the delegate iterator has a return method, give it a
            // chance to clean up.
            var returnMethod = delegate.iterator["return"];
            if (returnMethod) {
              var record = tryCatch(returnMethod, delegate.iterator, arg);
              if (record.type === "throw") {
                // If the return method threw an exception, let that
                // exception prevail over the original return or throw.
                method = "throw";
                arg = record.arg;
                continue;
              }
            }

            if (method === "return") {
              // Continue with the outer return, now that the delegate
              // iterator has been terminated.
              continue;
            }
          }

          var record = tryCatch(delegate.iterator[method], delegate.iterator, arg);

          if (record.type === "throw") {
            context.delegate = null;

            // Like returning generator.throw(uncaught), but without the
            // overhead of an extra function call.
            method = "throw";
            arg = record.arg;
            continue;
          }

          // Delegate generator ran and handled its own exceptions so
          // regardless of what the method was, we continue as if it is
          // "next" with an undefined arg.
          method = "next";
          arg = undefined;

          var info = record.arg;
          if (info.done) {
            context[delegate.resultName] = info.value;
            context.next = delegate.nextLoc;
          } else {
            state = GenStateSuspendedYield;
            return info;
          }

          context.delegate = null;
        }

        if (method === "next") {
          if (state === GenStateSuspendedYield) {
            context.sent = arg;
          } else {
            context.sent = undefined;
          }
        } else if (method === "throw") {
          if (state === GenStateSuspendedStart) {
            state = GenStateCompleted;
            throw arg;
          }

          if (context.dispatchException(arg)) {
            // If the dispatched exception was caught by a catch block,
            // then let that catch block handle the exception normally.
            method = "next";
            arg = undefined;
          }
        } else if (method === "return") {
          context.abrupt("return", arg);
        }

        state = GenStateExecuting;

        var record = tryCatch(innerFn, self, context);
        if (record.type === "normal") {
          // If an exception is thrown from innerFn, we leave state ===
          // GenStateExecuting and loop back for another invocation.
          state = context.done ? GenStateCompleted : GenStateSuspendedYield;

          var info = {
            value: record.arg,
            done: context.done
          };

          if (record.arg === ContinueSentinel) {
            if (context.delegate && method === "next") {
              // Deliberately forget the last sent value so that we don't
              // accidentally pass it on to the delegate.
              arg = undefined;
            }
          } else {
            return info;
          }
        } else if (record.type === "throw") {
          state = GenStateCompleted;
          // Dispatch the exception by looping back around to the
          // context.dispatchException(arg) call above.
          method = "throw";
          arg = record.arg;
        }
      }
    };
  }

  // Define Generator.prototype.{next,throw,return} in terms of the
  // unified ._invoke helper method.
  defineIteratorMethods(Gp);

  Gp[iteratorSymbol] = function () {
    return this;
  };

  Gp.toString = function () {
    return "[object Generator]";
  };

  function pushTryEntry(locs) {
    var entry = { tryLoc: locs[0] };

    if (1 in locs) {
      entry.catchLoc = locs[1];
    }

    if (2 in locs) {
      entry.finallyLoc = locs[2];
      entry.afterLoc = locs[3];
    }

    this.tryEntries.push(entry);
  }

  function resetTryEntry(entry) {
    var record = entry.completion || {};
    record.type = "normal";
    delete record.arg;
    entry.completion = record;
  }

  function Context(tryLocsList) {
    // The root entry object (effectively a try statement without a catch
    // or a finally block) gives us a place to store values thrown from
    // locations where there is no enclosing try statement.
    this.tryEntries = [{ tryLoc: "root" }];
    tryLocsList.forEach(pushTryEntry, this);
    this.reset(true);
  }

  runtime.keys = function (object) {
    var keys = [];
    for (var key in object) {
      keys.push(key);
    }
    keys.reverse();

    // Rather than returning an object with a next method, we keep
    // things simple and return the next function itself.
    return function next() {
      while (keys.length) {
        var key = keys.pop();
        if (key in object) {
          next.value = key;
          next.done = false;
          return next;
        }
      }

      // To avoid creating an additional object, we just hang the .value
      // and .done properties off the next function object itself. This
      // also ensures that the minifier will not anonymize the function.
      next.done = true;
      return next;
    };
  };

  function values(iterable) {
    if (iterable) {
      var iteratorMethod = iterable[iteratorSymbol];
      if (iteratorMethod) {
        return iteratorMethod.call(iterable);
      }

      if (typeof iterable.next === "function") {
        return iterable;
      }

      if (!isNaN(iterable.length)) {
        var i = -1,
            next = function next() {
          while (++i < iterable.length) {
            if (hasOwn.call(iterable, i)) {
              next.value = iterable[i];
              next.done = false;
              return next;
            }
          }

          next.value = undefined;
          next.done = true;

          return next;
        };

        return next.next = next;
      }
    }

    // Return an iterator with no values.
    return { next: doneResult };
  }
  runtime.values = values;

  function doneResult() {
    return { value: undefined, done: true };
  }

  Context.prototype = {
    constructor: Context,

    reset: function reset(skipTempReset) {
      this.prev = 0;
      this.next = 0;
      this.sent = undefined;
      this.done = false;
      this.delegate = null;

      this.tryEntries.forEach(resetTryEntry);

      if (!skipTempReset) {
        for (var name in this) {
          // Not sure about the optimal order of these conditions:
          if (name.charAt(0) === "t" && hasOwn.call(this, name) && !isNaN(+name.slice(1))) {
            this[name] = undefined;
          }
        }
      }
    },

    stop: function stop() {
      this.done = true;

      var rootEntry = this.tryEntries[0];
      var rootRecord = rootEntry.completion;
      if (rootRecord.type === "throw") {
        throw rootRecord.arg;
      }

      return this.rval;
    },

    dispatchException: function dispatchException(exception) {
      if (this.done) {
        throw exception;
      }

      var context = this;
      function handle(loc, caught) {
        record.type = "throw";
        record.arg = exception;
        context.next = loc;
        return !!caught;
      }

      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        var record = entry.completion;

        if (entry.tryLoc === "root") {
          // Exception thrown outside of any try block that could handle
          // it, so set the completion value of the entire function to
          // throw the exception.
          return handle("end");
        }

        if (entry.tryLoc <= this.prev) {
          var hasCatch = hasOwn.call(entry, "catchLoc");
          var hasFinally = hasOwn.call(entry, "finallyLoc");

          if (hasCatch && hasFinally) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            } else if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }
          } else if (hasCatch) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            }
          } else if (hasFinally) {
            if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }
          } else {
            throw new Error("try statement without catch or finally");
          }
        }
      }
    },

    abrupt: function abrupt(type, arg) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc <= this.prev && hasOwn.call(entry, "finallyLoc") && this.prev < entry.finallyLoc) {
          var finallyEntry = entry;
          break;
        }
      }

      if (finallyEntry && (type === "break" || type === "continue") && finallyEntry.tryLoc <= arg && arg <= finallyEntry.finallyLoc) {
        // Ignore the finally entry if control is not jumping to a
        // location outside the try/catch block.
        finallyEntry = null;
      }

      var record = finallyEntry ? finallyEntry.completion : {};
      record.type = type;
      record.arg = arg;

      if (finallyEntry) {
        this.next = finallyEntry.finallyLoc;
      } else {
        this.complete(record);
      }

      return ContinueSentinel;
    },

    complete: function complete(record, afterLoc) {
      if (record.type === "throw") {
        throw record.arg;
      }

      if (record.type === "break" || record.type === "continue") {
        this.next = record.arg;
      } else if (record.type === "return") {
        this.rval = record.arg;
        this.next = "end";
      } else if (record.type === "normal" && afterLoc) {
        this.next = afterLoc;
      }
    },

    finish: function finish(finallyLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.finallyLoc === finallyLoc) {
          this.complete(entry.completion, entry.afterLoc);
          resetTryEntry(entry);
          return ContinueSentinel;
        }
      }
    },

    "catch": function _catch(tryLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc === tryLoc) {
          var record = entry.completion;
          if (record.type === "throw") {
            var thrown = record.arg;
            resetTryEntry(entry);
          }
          return thrown;
        }
      }

      // The context.catch method must only be called with a location
      // argument that corresponds to a known catch block.
      throw new Error("illegal catch attempt");
    },

    delegateYield: function delegateYield(iterable, resultName, nextLoc) {
      this.delegate = {
        iterator: values(iterable),
        resultName: resultName,
        nextLoc: nextLoc
      };

      return ContinueSentinel;
    }
  };
})(
// Among the various tricks for obtaining a reference to the global
// object, this seems to be the most reliable technique that does not
// use indirect eval (which violates Content Security Policy).
typeof global === "object" ? global : typeof window === "object" ? window : typeof self === "object" ? self : undefined);

function _slicedToArray(arr, i) {
  if (Array.isArray(arr)) {
    return arr;
  } else if (Symbol.iterator in Object(arr)) {
    var _arr = [];var _n = true;var _d = false;var _e = undefined;try {
      for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) {
        _arr.push(_s.value);if (i && _arr.length === i) break;
      }
    } catch (err) {
      _d = true;_e = err;
    } finally {
      try {
        if (!_n && _i["return"]) _i["return"]();
      } finally {
        if (_d) throw _e;
      }
    }return _arr;
  } else {
    throw new TypeError("Invalid attempt to destructure non-iterable instance");
  }
}(function (root, fn) {
  if (typeof define === "function" && define.amd) {
    define(fn);
  } else if (typeof module !== "undefined" && module.exports) {
    module.exports = fn();
  } else {
    root.jsmime = fn();
  }
})(undefined, function () {
  var mods = {};function req(id) {
    return mods[id.replace(/^\.\//, "")];
  }function def(id, fn) {
    mods[id] = fn(req);
  }def("mimeutils", function () {
    "use strict";function decode_qp(buffer, more) {
      var decoded = buffer.replace(/=([0-9A-F][0-9A-F]|[ \t]*(\r\n|[\r\n]|$))/gi, function replace_chars(match, param) {
        if (param.trim().length == 0) return "";return String.fromCharCode(parseInt(param, 16));
      });return [decoded, ""];
    }function decode_base64(buffer, more) {
      var sanitize = buffer.replace(/[^A-Za-z0-9+\/=]/g, "");var excess = sanitize.length % 4;if (excess != 0 && more) buffer = sanitize.slice(-excess);else buffer = "";sanitize = sanitize.substring(0, sanitize.length - excess);return [atob(sanitize), buffer];
    }function stringToTypedArray(buffer) {
      var typedarray = new Uint8Array(buffer.length);for (var i = 0; i < buffer.length; i++) typedarray[i] = buffer.charCodeAt(i);return typedarray;
    }function typedArrayToString(buffer) {
      var string = "";for (var i = 0; i < buffer.length; i += 100) string += String.fromCharCode.apply(undefined, buffer.subarray(i, i + 100));return string;
    }var kMonthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];return { decode_base64: decode_base64, decode_qp: decode_qp, kMonthNames: kMonthNames, stringToTypedArray: stringToTypedArray, typedArrayToString: typedArrayToString };
  });def("structuredHeaders", function (require) {
    "use strict";var structuredDecoders = new Map();var structuredEncoders = new Map();var preferredSpellings = new Map();function addHeader(name, decoder, encoder) {
      var lowerName = name.toLowerCase();structuredDecoders.set(lowerName, decoder);structuredEncoders.set(lowerName, encoder);preferredSpellings.set(lowerName, name);
    }function parseAddress(value) {
      var results = [];var headerparser = this;return value.reduce(function (results, header) {
        return results.concat(headerparser.parseAddressingHeader(header, true));
      }, []);
    }function writeAddress(value) {
      if (!Array.isArray(value)) value = [value];this.addAddresses(value);
    }addHeader("Bcc", parseAddress, writeAddress);addHeader("Cc", parseAddress, writeAddress);addHeader("From", parseAddress, writeAddress);addHeader("Reply-To", parseAddress, writeAddress);addHeader("Resent-Bcc", parseAddress, writeAddress);addHeader("Resent-Cc", parseAddress, writeAddress);addHeader("Resent-From", parseAddress, writeAddress);addHeader("Resent-Sender", parseAddress, writeAddress);addHeader("Resent-To", parseAddress, writeAddress);addHeader("Sender", parseAddress, writeAddress);addHeader("To", parseAddress, writeAddress);addHeader("Approved", parseAddress, writeAddress);addHeader("Disposition-Notification-To", parseAddress, writeAddress);addHeader("Delivered-To", parseAddress, writeAddress);addHeader("Return-Receipt-To", parseAddress, writeAddress);function parseParameterHeader(value, do2231, do2047) {
      return this.parseParameterHeader(value[0], do2231, do2047);
    }function parseContentType(value) {
      var params = parseParameterHeader.call(this, value, false, false);var origtype = params.preSemi;var parts = origtype.split("/");if (parts.length != 2) {
        params = new Map();parts = ["text", "plain"];
      }var mediatype = parts[0].toLowerCase();var subtype = parts[1].toLowerCase();var type = mediatype + "/" + subtype;var structure = new Map();structure.mediatype = mediatype;structure.subtype = subtype;structure.type = type;params.forEach(function (value, name) {
        structure.set(name.toLowerCase(), value);
      });return structure;
    }structuredDecoders.set("Content-Type", parseContentType);function parseUnstructured(values) {
      return this.decodeRFC2047Words(values[0]);
    }function writeUnstructured(value) {
      this.addUnstructured(value);
    }addHeader("Comments", parseUnstructured, writeUnstructured);addHeader("Keywords", parseUnstructured, writeUnstructured);addHeader("Subject", parseUnstructured, writeUnstructured);addHeader("Content-Description", parseUnstructured, writeUnstructured);function parseDate(values) {
      return this.parseDateHeader(values[0]);
    }function writeDate(value) {
      this.addDate(value);
    }addHeader("Date", parseDate, writeDate);addHeader("Resent-Date", parseDate, writeDate);addHeader("Expires", parseDate, writeDate);addHeader("Injection-Date", parseDate, writeDate);addHeader("NNTP-Posting-Date", parseDate, writeDate);structuredDecoders.set("Content-Transfer-Encoding", function (values) {
      return values[0].toLowerCase();
    });structuredEncoders.set("Content-Transfer-Encoding", writeUnstructured);return Object.freeze({ decoders: structuredDecoders, encoders: structuredEncoders, spellings: preferredSpellings });
  });def("headerparser", function (require) {
    "use strict";var mimeutils = require("./mimeutils");var headerparser = {};function getHeaderTokens(value, delimiters, opts) {
      var tokenList = [];function Token(token) {
        this.token = token.replace(/\\(.?)/g, "$1");
      }Token.prototype.toString = function () {
        return this.token;
      };var tokenStart = undefined;var wsp = " \t\r\n";var endQuote = undefined;var commentDepth = 0;var length = value.length;for (var i = 0; i < length; i++) {
        var ch = value[i];if (ch == "\\") {
          i++;continue;
        }if (endQuote !== undefined) {
          if (ch == endQuote && ch == "\"") {
            var text = value.slice(tokenStart + 1, i);if (opts.rfc2047 && text.startsWith("=?") && text.endsWith("?=")) text = decodeRFC2047Words(text);tokenList.push(new Token(text));endQuote = undefined;tokenStart = undefined;
          } else if (ch == endQuote && ch == "]") {
            tokenList.push(new Token(value.slice(tokenStart, i + 1)));endQuote = undefined;tokenStart = undefined;
          }continue;
        }if (opts.rfc2047 && ch == "=" && i + 1 < value.length && value[i + 1] == "?") {
          var encodedWordsRE = /([ \t\r\n]*=\?[^?]*\?[BbQq]\?[^?]*\?=)+/;var result = encodedWordsRE.exec(value.slice(i));if (result !== null) {
            var _ret = (function () {
              if (tokenStart !== undefined) {
                tokenList.push(new Token(value.slice(tokenStart, i)));tokenStart = undefined;
              }var encWordsLen = result[0].length;var string = decodeRFC2047Words(value.slice(i, i + encWordsLen), "UTF-8");tokenList.push({ toString: function toString() {
                  return string;
                } });i += encWordsLen - 1;return "continue";
            })();if (_ret === "continue") continue;
          }
        }var tokenIsEnding = false,
            tokenIsStarting = false,
            isSpecial = false;if (wsp.contains(ch)) {
          tokenIsEnding = true;
        } else if (commentDepth == 0 && delimiters.contains(ch)) {
          tokenIsEnding = true;isSpecial = true;
        } else if (opts.qstring && ch == "\"") {
          tokenIsEnding = true;tokenIsStarting = true;endQuote = ch;
        } else if (opts.dliteral && ch == "[") {
          tokenIsEnding = true;tokenIsStarting = true;endQuote = "]";
        } else if (opts.comments && ch == "(") {
          commentDepth++;tokenIsEnding = true;isSpecial = true;
        } else if (opts.comments && ch == ")") {
          if (commentDepth > 0) commentDepth--;tokenIsEnding = true;isSpecial = true;
        } else {
          tokenIsStarting = true;
        }if (tokenIsEnding && tokenStart !== undefined) {
          tokenList.push(new Token(value.slice(tokenStart, i)));tokenStart = undefined;
        }if (isSpecial) tokenList.push(ch);if (tokenIsStarting && tokenStart === undefined) {
          tokenStart = i;
        }
      }if (tokenStart !== undefined) {
        if (endQuote == "\"") tokenList.push(new Token(value.slice(tokenStart + 1)));else tokenList.push(new Token(value.slice(tokenStart)));
      }return tokenList;
    }function convert8BitHeader(headerValue, fallbackCharset) {
      if (/[\x80-\xff]/.exec(headerValue)) {
        var typedarray = mimeutils.stringToTypedArray(headerValue);var hasFallback = fallbackCharset && !fallbackCharset.toLowerCase().startsWith("utf");var utf8Decoder = new TextDecoder("utf-8", { fatal: hasFallback });try {
          headerValue = utf8Decoder.decode(typedarray);
        } catch (e) {
          var decoder = new TextDecoder(fallbackCharset, { fatal: false });headerValue = decoder.decode(typedarray);
        }
      }return headerValue;
    }function decodeRFC2047Words(headerValue) {
      var lastCharset = "",
          currentDecoder = undefined;function decode2047Token(token) {
        var tokenParts = token.split("?");if (tokenParts.length != 5 || tokenParts[4] != "=") return false;var charset = tokenParts[1].split("*", 1)[0];var encoding = tokenParts[2],
            text = tokenParts[3];var buffer = undefined;if (encoding == "B" || encoding == "b") {
          if (/[^A-Za-z0-9+\/=]/.exec(text)) return false;if (text.length % 4 == 1 && text.charAt(text.length - 1) == "=") text = text.slice(0, -1);buffer = mimeutils.decode_base64(text, false)[0];
        } else if (encoding == "Q" || encoding == "q") {
          buffer = mimeutils.decode_qp(text.replace("_", " ", "g"), false)[0];
        } else {
          return false;
        }buffer = mimeutils.stringToTypedArray(buffer);var output = "";if (charset != lastCharset && currentDecoder) {
          output += currentDecoder.decode();currentDecoder = null;
        }lastCharset = charset;if (!currentDecoder) {
          try {
            currentDecoder = new TextDecoder(charset, { fatal: false });
          } catch (e) {
            return false;
          }
        }return output + currentDecoder.decode(buffer, { stream: true });
        }if (!headerValue) console.warn(new Error().stack)
      var components = headerValue.split(/(=\?[^?]*\?[BQbq]\?[^?]*\?=)/);for (var i = 0; i < components.length; i++) {
        if (components[i].substring(0, 2) == "=?") {
          var decoded = decode2047Token(components[i]);if (decoded !== false) {
            components[i] = decoded;continue;
          }
        } else if (/^[ \t\r\n]*$/.exec(components[i])) {
          components[i] = "";continue;
        }lastCharset = "";if (currentDecoder) {
          components[i] = currentDecoder.decode() + components[i];currentDecoder = null;
        }
      }return components.join("");
    }function parseAddressingHeader(header, doRFC2047) {
      if (doRFC2047 === undefined) doRFC2047 = true;var results = [];var addrlist = [];var name = "",
          groupName = "",
          address = "";var inAngle = false,
          needsSpace = false;var _iteratorNormalCompletion = true;var _didIteratorError = false;var _iteratorError = undefined;try {
        for (var _iterator = getHeaderTokens(header, ":,;<>@", { qstring: true, comments: true, dliteral: true, rfc2047: doRFC2047 })[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
          var token = _step.value;if (token === ":") {
            groupName = name;name = "";if (addrlist.length > 0) results = results.concat(addrlist);addrlist = [];
          } else if (token === "<") {
            inAngle = true;
          } else if (token === ">") {
            inAngle = false;
          } else if (token === "@") {
            if (!inAngle) {
              address = name;name = "";
            }if (/[ !()<>\[\]:;@\\,"]/.exec(address) !== null) address = "\"" + address.replace(/([\\"])/g, "\\$1") + "\"";address += "@";
          } else if (token === ",") {
            if (name !== "" || address !== "") addrlist.push({ name: name, email: address });name = address = "";
          } else if (token === ";") {
            if (name !== "" || address !== "") addrlist.push({ name: name, email: address });if (groupName === "") {
              results = results.concat(addrlist);
            } else {
              results.push({ name: groupName, group: addrlist });
            }addrlist = [];groupName = name = address = "";
          } else {
            if (needsSpace && token !== ")" && token.toString()[0] != ".") token = " " + token;if (inAngle || address !== "") address += token;else name += token;needsSpace = token !== "(" && token !== " (" && token.toString()[0] != ".";continue;
          }needsSpace = false;
        }
      } catch (err) {
        _didIteratorError = true;_iteratorError = err;
      } finally {
        try {
          if (!_iteratorNormalCompletion && _iterator["return"]) {
            _iterator["return"]();
          }
        } finally {
          if (_didIteratorError) {
            throw _iteratorError;
          }
        }
      }if (name !== "" || address !== "") addrlist.push({ name: name, email: address });if (groupName !== "") {
        results.push({ name: groupName, group: addrlist });addrlist = [];
      }return results.concat(addrlist);
    }function parseParameterHeader(headerValue, doRFC2047, doRFC2231) {
      var semi = headerValue.indexOf(";");if (semi < 0) {
        var start = headerValue;var rest = "";
      } else {
        var start = headerValue.substring(0, semi);var rest = headerValue.substring(semi);
      }start = start.trim().split(/[ \t\r\n]/)[0];var opts = { qstring: true, rfc2047: doRFC2047 };var name = "",
          inName = true;var matches = [];var _iteratorNormalCompletion2 = true;var _didIteratorError2 = false;var _iteratorError2 = undefined;try {
        for (var _iterator2 = getHeaderTokens(rest, ";=", opts)[Symbol.iterator](), _step2; !(_iteratorNormalCompletion2 = (_step2 = _iterator2.next()).done); _iteratorNormalCompletion2 = true) {
          var token = _step2.value;if (token === ";") {
            if (name != "" && inName == false) matches.push([name, ""]);name = "";inName = true;
          } else if (token === "=") {
            inName = false;
          } else if (inName && name == "") {
            name = token.toString();
          } else if (!inName && name != "") {
            token = token.toString();if (doRFC2231 && name.endsWith("*")) {
              token = token.replace(/%([0-9A-Fa-f]{2})/g, function percent_deencode(match, hexchars) {
                return String.fromCharCode(parseInt(hexchars, 16));
              });
            }matches.push([name, token]);name = "";
          } else if (inName) {
            name = "";
          }
        }
      } catch (err) {
        _didIteratorError2 = true;_iteratorError2 = err;
      } finally {
        try {
          if (!_iteratorNormalCompletion2 && _iterator2["return"]) {
            _iterator2["return"]();
          }
        } finally {
          if (_didIteratorError2) {
            throw _iteratorError2;
          }
        }
      }if (name != "" && inName == false) matches.push([name, ""]);var simpleValues = new Map(),
          charsetValues = new Map(),
          continuationValues = new Map();var _iteratorNormalCompletion3 = true;var _didIteratorError3 = false;var _iteratorError3 = undefined;try {
        for (var _iterator3 = matches[Symbol.iterator](), _step3; !(_iteratorNormalCompletion3 = (_step3 = _iterator3.next()).done); _iteratorNormalCompletion3 = true) {
          var pair = _step3.value;var _name = pair[0];var _value = pair[1];var star = _name.indexOf("*");if (star == -1) {
            if (!simpleValues.has(_name)) simpleValues.set(_name, _value);
          } else if (star == _name.length - 1) {
            _name = _name.substring(0, star);if (!charsetValues.has(_name)) charsetValues.set(_name, _value);
          } else {
            var param = _name.substring(0, star);var entry = continuationValues.get(param);if (continuationValues.has(param) && !entry.valid) continue;if (!continuationValues.has(param)) {
              entry = new Array();entry.valid = true;entry.hasCharset = undefined;continuationValues.set(param, entry);
            }var lastStar = _name[_name.length - 1] == "*";var number = _name.substring(star + 1, _name.length - (lastStar ? 1 : 0));if (number == "0") entry.hasCharset = lastStar;else if (number[0] == "0" && number != "0" || !/^[0-9]+$/.test(number)) {
              entry.valid = false;continue;
            }number = parseInt(number, 10);if (entry[number] !== undefined) {
              entry.valid = false;continue;
            }entry[number] = _value;
          }
        }
      } catch (err) {
        _didIteratorError3 = true;_iteratorError3 = err;
      } finally {
        try {
          if (!_iteratorNormalCompletion3 && _iterator3["return"]) {
            _iterator3["return"]();
          }
        } finally {
          if (_didIteratorError3) {
            throw _iteratorError3;
          }
        }
      }var values = new Map();var _iteratorNormalCompletion4 = true;var _didIteratorError4 = false;var _iteratorError4 = undefined;try {
        for (var _iterator4 = simpleValues[Symbol.iterator](), _step4; !(_iteratorNormalCompletion4 = (_step4 = _iterator4.next()).done); _iteratorNormalCompletion4 = true) {
          var pair = _step4.value;values.set(pair[0], pair[1]);
        }
      } catch (err) {
        _didIteratorError4 = true;_iteratorError4 = err;
      } finally {
        try {
          if (!_iteratorNormalCompletion4 && _iterator4["return"]) {
            _iterator4["return"]();
          }
        } finally {
          if (_didIteratorError4) {
            throw _iteratorError4;
          }
        }
      }if (doRFC2231) {
        var _iteratorNormalCompletion5 = true;var _didIteratorError5 = false;var _iteratorError5 = undefined;try {
          for (var _iterator5 = continuationValues[Symbol.iterator](), _step5; !(_iteratorNormalCompletion5 = (_step5 = _iterator5.next()).done); _iteratorNormalCompletion5 = true) {
            var pair = _step5.value;var _name2 = pair[0];var entry = pair[1];if (entry.hasCharset === undefined) continue;var valid = true;for (var i = 0; valid && i < entry.length; i++) if (entry[i] === undefined) valid = false;var value = entry.slice(0, i).join("");if (entry.hasCharset) {
              try {
                value = decode2231Value(value);
              } catch (e) {
                continue;
              }
            }values.set(_name2, value);
          }
        } catch (err) {
          _didIteratorError5 = true;_iteratorError5 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion5 && _iterator5["return"]) {
              _iterator5["return"]();
            }
          } finally {
            if (_didIteratorError5) {
              throw _iteratorError5;
            }
          }
        }var _iteratorNormalCompletion6 = true;var _didIteratorError6 = false;var _iteratorError6 = undefined;try {
          for (var _iterator6 = charsetValues[Symbol.iterator](), _step6; !(_iteratorNormalCompletion6 = (_step6 = _iterator6.next()).done); _iteratorNormalCompletion6 = true) {
            var pair = _step6.value;try {
              values.set(pair[0], decode2231Value(pair[1]));
            } catch (e) {}
          }
        } catch (err) {
          _didIteratorError6 = true;_iteratorError6 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion6 && _iterator6["return"]) {
              _iterator6["return"]();
            }
          } finally {
            if (_didIteratorError6) {
              throw _iteratorError6;
            }
          }
        }
      }values.preSemi = start;return values;
    }function decode2231Value(value) {
      var quote1 = value.indexOf("'");var quote2 = quote1 >= 0 ? value.indexOf("'", quote1 + 1) : -1;var charset = quote1 >= 0 ? value.substring(0, quote1) : "";value = value.substring(Math.max(quote1, quote2) + 1);var typedarray = mimeutils.stringToTypedArray(value);return new TextDecoder(charset, { fatal: true }).decode(typedarray, { stream: false });
    }var kKnownTZs = { "UT": "+0000", "GMT": "+0000", "EST": "-0500", "EDT": "-0400", "CST": "-0600", "CDT": "-0500", "MST": "-0700", "MDT": "-0600", "PST": "-0800", "PDT": "-0700", "AST": "-0400", "NST": "-0330", "BST": "+0100", "MET": "+0100", "EET": "+0200", "JST": "+0900" };function parseDateHeader(header) {
      var tokens = getHeaderTokens(header, ",:", {}).map(function (x) {
        return x.toString();
      });if (tokens.length > 1 && tokens[1] === ",") tokens = tokens.slice(2);if (tokens.length < 8) return new Date(NaN);var day = parseInt(tokens[0]);var year = parseInt(tokens[2]);var hours = parseInt(tokens[3]);var minutes = parseInt(tokens[5]);var seconds = parseInt(tokens[7]);var month = mimeutils.kMonthNames.indexOf(tokens[1].slice(0, 3));if (month < 0) month = NaN;if (year < 100) {
        year += year < 50 ? 2000 : 1900;
      }var tzoffset = tokens[8];if (tzoffset in kKnownTZs) tzoffset = kKnownTZs[tzoffset];var decompose = /^([+-])(\d\d)(\d\d)$/.exec(tzoffset);if (decompose === null) decompose = ["+0000", "+", "00", "00"];var tzOffsetInMin = parseInt(decompose[2]) * 60 + parseInt(decompose[3]);if (decompose[1] == "-") tzOffsetInMin = -tzOffsetInMin;var finalDate = new Date(Date.UTC(year, month, day, hours, minutes, seconds) - tzOffsetInMin * 60 * 1000);return finalDate;
    }var structuredDecoders = new Map();var structuredHeaders = require("./structuredHeaders");var preferredSpellings = structuredHeaders.spellings;var forbiddenHeaders = new Set();var _iteratorNormalCompletion7 = true;var _didIteratorError7 = false;var _iteratorError7 = undefined;try {
      for (var _iterator7 = structuredHeaders.decoders[Symbol.iterator](), _step7; !(_iteratorNormalCompletion7 = (_step7 = _iterator7.next()).done); _iteratorNormalCompletion7 = true) {
        var pair = _step7.value;addStructuredDecoder(pair[0], pair[1]);forbiddenHeaders.add(pair[0].toLowerCase());
      }
    } catch (err) {
      _didIteratorError7 = true;_iteratorError7 = err;
    } finally {
      try {
        if (!_iteratorNormalCompletion7 && _iterator7["return"]) {
          _iterator7["return"]();
        }
      } finally {
        if (_didIteratorError7) {
          throw _iteratorError7;
        }
      }
    }function parseStructuredHeader(header, value) {
      if (typeof value === "string" || value instanceof String) value = [value];if (!Array.isArray(value)) throw new TypeError("Header value is not an array: " + value);var lowerHeader = header.toLowerCase();if (structuredDecoders.has(lowerHeader)) {
        return structuredDecoders.get(lowerHeader).call(headerparser, value);
      }throw new Error("Unknown structured header: " + header);
    }function addStructuredDecoder(header, decoder) {
      var lowerHeader = header.toLowerCase();if (forbiddenHeaders.has(lowerHeader)) throw new Error("Cannot override header: " + header);structuredDecoders.set(lowerHeader, decoder);if (!preferredSpellings.has(lowerHeader)) preferredSpellings.set(lowerHeader, header);
    }headerparser.addStructuredDecoder = addStructuredDecoder;headerparser.convert8BitHeader = convert8BitHeader;headerparser.decodeRFC2047Words = decodeRFC2047Words;headerparser.getHeaderTokens = getHeaderTokens;headerparser.parseAddressingHeader = parseAddressingHeader;headerparser.parseDateHeader = parseDateHeader;headerparser.parseParameterHeader = parseParameterHeader;headerparser.parseStructuredHeader = parseStructuredHeader;return Object.freeze(headerparser);
  });def("mimeparser", function (require) {
    "use strict";var mimeutils = require("./mimeutils");var headerparser = require("./headerparser");var spellings = require("./structuredHeaders").spellings;function StructuredHeaders(rawHeaderText, options) {
      var values = rawHeaderText.split(/(?:\r\n|\n)(?![ \t])|\r(?![ \t\n])/);if (values.length > 0 && values[0].substring(0, 5) == "From ") {
        values.shift();if (values.length == 0) rawHeaderText = "";else rawHeaderText = rawHeaderText.substring(rawHeaderText.indexOf(values[0]));
      }var headers = new Map();for (var i = 0; i < values.length; i++) {
        var colon = values[i].indexOf(":");if (colon >= 0) {
          var header = values[i].substring(0, colon);var val = values[i].substring(colon + 1).trim();if (options.stripcontinuations) val = val.replace(/[\r\n]/g, "");
        } else {
          var header = values[i];var val = "";
        }header = header.trim().toLowerCase();if (header == "") continue;if (headers.has(header)) {
          headers.get(header).push(val);
        } else {
          headers.set(header, [val]);
        }
      }this._rawHeaders = headers;this._cachedHeaders = new Map();Object.defineProperty(this, "rawHeaderText", { get: function get() {
          return rawHeaderText;
        } });Object.defineProperty(this, "size", { get: function get() {
          return this._rawHeaders.size;
        } });Object.defineProperty(this, "charset", { get: function get() {
          return this._charset;
        }, set: function set(value) {
          this._charset = value;this._cachedHeaders.clear();
        } });if ("charset" in options) this._charset = options.charset;else this._charset = null;Object.defineProperty(this, "contentType", { configurable: true, get: function get() {
          return this.get("Content-Type");
        } });
    }StructuredHeaders.prototype.getRawHeader = function (headerName) {
      return this._rawHeaders.get(headerName.toLowerCase());
    };StructuredHeaders.prototype.get = function (headerName) {
      headerName = headerName.toLowerCase();if (this._cachedHeaders.has(headerName)) return this._cachedHeaders.get(headerName);var headerValue = this._rawHeaders.get(headerName);if (headerValue === undefined) return headerValue;var charset = this.charset;headerValue = headerValue.map(function (value) {
        return headerparser.convert8BitHeader(value, charset);
      });var structured = undefined;try {
        structured = headerparser.parseStructuredHeader(headerName, headerValue);
      } catch (e) {
        structured = headerValue.map(function (value) {
          return headerparser.decodeRFC2047Words(value);
        });
      }this._cachedHeaders.set(headerName, structured);return structured;
    };StructuredHeaders.prototype.has = function (headerName) {
      return this._rawHeaders.has(headerName.toLowerCase());
    };if (typeof Symbol === "undefined") {
      var Symbol = { iterator: "@@iterator" };
    }StructuredHeaders.prototype[Symbol.iterator] = regeneratorRuntime.mark(function callee$2$0() {
      var _iteratorNormalCompletion8, _didIteratorError8, _iteratorError8, _iterator8, _step8, headerName;return regeneratorRuntime.wrap(function callee$2$0$(context$3$0) {
        while (1) switch (context$3$0.prev = context$3$0.next) {case 0:
            _iteratorNormalCompletion8 = true;_didIteratorError8 = false;_iteratorError8 = undefined;context$3$0.prev = 3;_iterator8 = this.keys()[Symbol.iterator]();case 5:
            if (_iteratorNormalCompletion8 = (_step8 = _iterator8.next()).done) {
              context$3$0.next = 12;break;
            }headerName = _step8.value;context$3$0.next = 9;return [headerName, this.get(headerName)];case 9:
            _iteratorNormalCompletion8 = true;context$3$0.next = 5;break;case 12:
            context$3$0.next = 18;break;case 14:
            context$3$0.prev = 14;context$3$0.t0 = context$3$0["catch"](3);_didIteratorError8 = true;_iteratorError8 = context$3$0.t0;case 18:
            context$3$0.prev = 18;context$3$0.prev = 19;if (!_iteratorNormalCompletion8 && _iterator8["return"]) {
              _iterator8["return"]();
            }case 21:
            context$3$0.prev = 21;if (!_didIteratorError8) {
              context$3$0.next = 24;break;
            }throw _iteratorError8;case 24:
            return context$3$0.finish(21);case 25:
            return context$3$0.finish(18);case 26:case "end":
            return context$3$0.stop();}
      }, callee$2$0, this, [[3, 14, 18, 26], [19,, 21, 25]]);
    });StructuredHeaders.prototype.forEach = function (callback, thisarg) {
      var _iteratorNormalCompletion9 = true;var _didIteratorError9 = false;var _iteratorError9 = undefined;try {
        for (var _iterator9 = this[Symbol.iterator](), _step9; !(_iteratorNormalCompletion9 = (_step9 = _iterator9.next()).done); _iteratorNormalCompletion9 = true) {
          var _step9$value = _slicedToArray(_step9.value, 2);var header = _step9$value[0];var value = _step9$value[1];callback.call(thisarg, value, header, this);
        }
      } catch (err) {
        _didIteratorError9 = true;_iteratorError9 = err;
      } finally {
        try {
          if (!_iteratorNormalCompletion9 && _iterator9["return"]) {
            _iterator9["return"]();
          }
        } finally {
          if (_didIteratorError9) {
            throw _iteratorError9;
          }
        }
      }
    };StructuredHeaders.prototype.entries = StructuredHeaders.prototype[Symbol.iterator];function capitalize(headerName) {
      return headerName.replace(/\b[a-z]/g, function (match) {
        return match.toUpperCase();
      });
    }StructuredHeaders.prototype.keys = regeneratorRuntime.mark(function callee$2$0() {
      var _iteratorNormalCompletion10, _didIteratorError10, _iteratorError10, _iterator10, _step10, _name3;return regeneratorRuntime.wrap(function callee$2$0$(context$3$0) {
        while (1) switch (context$3$0.prev = context$3$0.next) {case 0:
            _iteratorNormalCompletion10 = true;_didIteratorError10 = false;_iteratorError10 = undefined;context$3$0.prev = 3;_iterator10 = this._rawHeaders.keys()[Symbol.iterator]();case 5:
            if (_iteratorNormalCompletion10 = (_step10 = _iterator10.next()).done) {
              context$3$0.next = 12;break;
            }_name3 = _step10.value;context$3$0.next = 9;return spellings.get(_name3) || capitalize(_name3);case 9:
            _iteratorNormalCompletion10 = true;context$3$0.next = 5;break;case 12:
            context$3$0.next = 18;break;case 14:
            context$3$0.prev = 14;context$3$0.t0 = context$3$0["catch"](3);_didIteratorError10 = true;_iteratorError10 = context$3$0.t0;case 18:
            context$3$0.prev = 18;context$3$0.prev = 19;if (!_iteratorNormalCompletion10 && _iterator10["return"]) {
              _iterator10["return"]();
            }case 21:
            context$3$0.prev = 21;if (!_didIteratorError10) {
              context$3$0.next = 24;break;
            }throw _iteratorError10;case 24:
            return context$3$0.finish(21);case 25:
            return context$3$0.finish(18);case 26:case "end":
            return context$3$0.stop();}
      }, callee$2$0, this, [[3, 14, 18, 26], [19,, 21, 25]]);
    });StructuredHeaders.prototype.values = regeneratorRuntime.mark(function callee$2$0() {
      var _iteratorNormalCompletion11, _didIteratorError11, _iteratorError11, _iterator11, _step11, _step11$value, value;return regeneratorRuntime.wrap(function callee$2$0$(context$3$0) {
        while (1) switch (context$3$0.prev = context$3$0.next) {case 0:
            _iteratorNormalCompletion11 = true;_didIteratorError11 = false;_iteratorError11 = undefined;context$3$0.prev = 3;_iterator11 = this[Symbol.iterator]();case 5:
            if (_iteratorNormalCompletion11 = (_step11 = _iterator11.next()).done) {
              context$3$0.next = 13;break;
            }_step11$value = _slicedToArray(_step11.value, 2);value = _step11$value[1];context$3$0.next = 10;return value;case 10:
            _iteratorNormalCompletion11 = true;context$3$0.next = 5;break;case 13:
            context$3$0.next = 19;break;case 15:
            context$3$0.prev = 15;context$3$0.t0 = context$3$0["catch"](3);_didIteratorError11 = true;_iteratorError11 = context$3$0.t0;case 19:
            context$3$0.prev = 19;context$3$0.prev = 20;if (!_iteratorNormalCompletion11 && _iterator11["return"]) {
              _iterator11["return"]();
            }case 22:
            context$3$0.prev = 22;if (!_didIteratorError11) {
              context$3$0.next = 25;break;
            }throw _iteratorError11;case 25:
            return context$3$0.finish(22);case 26:
            return context$3$0.finish(19);case 27:case "end":
            return context$3$0.stop();}
      }, callee$2$0, this, [[3, 15, 19, 27], [20,, 22, 26]]);
    });function MimeParser(emitter, options) {
      this._emitter = emitter;this._options = { pruneat: "", bodyformat: "nodecode", strformat: "binarystring", stripcontinuations: true, charset: "", "force-charset": false, onerror: function swallow(error) {} };if (options) for (var opt in options) {
        this._options[opt] = options[opt];
      }if (typeof this._options.onerror != "function") throw new Exception("onerror callback must be a function");this.resetParser();
    }MimeParser.prototype.resetParser = function () {
      this._state = PARSING_HEADERS;this._holdData = "";this._headerData = "";this._triggeredCall = false;this._splitRegex = this._handleSplit = undefined;this._subparser = this._subPartNum = undefined;this._savedBuffer = "";this._convertData = undefined;this._decoder = undefined;
    };MimeParser.prototype.deliverData = function (buffer) {
      if (this._holdData) {
        buffer = this._holdData + buffer;this._holdData = "";
      }if (buffer.length > 0) {
        var _temp = conditionToEndOnCRLF(buffer);var _temp2 = _slicedToArray(_temp, 2);buffer = _temp2[0];this._holdData = _temp2[1];_temp;
      }if (buffer.length == 0) return;if (!this._triggeredCall) {
        this._callEmitter("startMessage");this._triggeredCall = true;
      }this._dispatchData("", buffer, true);
    };function conditionToEndOnCRLF(buffer) {
      var lastCR = buffer.lastIndexOf("\r", buffer.length - 2);var lastLF = buffer.lastIndexOf("\n");var end = lastLF > lastCR ? lastLF : lastCR;return [buffer.substring(0, end + 1), buffer.substring(end + 1)];
    };MimeParser.prototype.deliverEOF = function () {
      if (!this._triggeredCall) {
        this._triggeredCall = true;this._callEmitter("startMessage");
      }if (this._holdData) this._dispatchData("", this._holdData, true);this._dispatchEOF("");this._callEmitter("endMessage");
    };MimeParser.prototype._callEmitter = function (funcname) {
      if (this._emitter && funcname in this._emitter) {
        var args = Array.prototype.splice.call(arguments, 1);if (args.length > 0 && this._willIgnorePart(args[0])) {
          return;
        }try {
          this._emitter[funcname].apply(this._emitter, args);
        } catch (e) {
          this._options.onerror(e);
        }
      }
    };MimeParser.prototype._willIgnorePart = function (part) {
      if (this._options["pruneat"]) {
        var match = this._options["pruneat"];var start = part.substr(0, match.length);if (start != match || match.length < part.length && "$.".indexOf(part[match.length]) == -1) return true;
      }return false;
    };var PARSING_HEADERS = 1;var SEND_TO_BLACK_HOLE = 2;var SEND_TO_EMITTER = 3;var SEND_TO_SUBPARSER = 4;MimeParser.prototype._dispatchData = function (partNum, buffer, checkSplit) {
      if (this._state == PARSING_HEADERS) {
        this._headerData += buffer;var result = /(?:^(?:\r\n|[\r\n]))|(\r\n|[\r\n])\1/.exec(this._headerData);if (result != null) {
          var headers = this._headerData.substr(0, result.index);buffer = this._headerData.substring(result.index + result[0].length);this._headerData = headers;this._headers = this._parseHeaders();this._callEmitter("startPart", partNum, this._headers);this._startBody(partNum);
        } else {
          return;
        }
      }if (checkSplit && this._splitRegex) {
        var splitResult = this._splitRegex.exec(buffer);if (splitResult) {
          var start = splitResult.index,
              len = splitResult[0].length;if (start > 0) this._dispatchData(partNum, buffer.substr(0, start), false);this._handleSplit(partNum, splitResult);buffer = buffer.substring(start + len);if (buffer.length > 0) this._dispatchData(partNum, buffer, true);return;
        }
      }if (this._state == SEND_TO_BLACK_HOLE) {
        return;
      } else if (this._state == SEND_TO_EMITTER) {
        var passData = this._options["bodyformat"] != "none";if (!passData || this._willIgnorePart(partNum)) return;buffer = this._applyDataConversion(buffer, this._options["strformat"]);if (buffer.length > 0) this._callEmitter("deliverPartData", partNum, buffer);
      } else if (this._state == SEND_TO_SUBPARSER) {
        buffer = this._applyDataConversion(buffer, "binarystring");if (buffer.length > 0) this._subparser._dispatchData(this._subPartNum, buffer, true);
      }
    };MimeParser.prototype._applyDataConversion = function (buf, type) {
      if (this._convertData) {
        buf = this._savedBuffer + buf;var _temp3 = this._convertData(buf, true);var _temp32 = _slicedToArray(_temp3, 2);buf = _temp32[0];this._savedBuffer = _temp32[1];_temp3;
      }return this._coerceData(buf, type, true);
    };MimeParser.prototype._coerceData = function (buffer, type, more) {
      if (typeof buffer == "string") {
        if (type == "binarystring") return buffer;var typedarray = mimeutils.stringToTypedArray(buffer);return type == "unicode" ? this._coerceData(typedarray, "unicode", more) : typedarray;
      } else if (type == "binarystring") {
        return mimeutils.typedArrayToString(buffer);
      } else if (type == "unicode") {
        if (this._decoder) return this._decoder.decode(buffer, { stream: more });return buffer;
      }throw new Error("Invalid type: " + type);
    };MimeParser.prototype._dispatchEOF = function (partNum) {
      if (this._state == PARSING_HEADERS) {
        this._headers = this._parseHeaders();this._callEmitter("startPart", partNum, this._headers);
      } else if (this._state == SEND_TO_SUBPARSER) {
        if (this._convertData && this._savedBuffer) this._subparser._dispatchData(this._subPartNum, this._convertData(this._savedBuffer, false)[0], true);this._subparser._dispatchEOF(this._subPartNum);this._subparser = null;
      } else if (this._convertData && this._savedBuffer) {
        var _convertData = this._convertData(this._savedBuffer, false);var _convertData2 = _slicedToArray(_convertData, 1);var buffer = _convertData2[0];buffer = this._coerceData(buffer, this._options["strformat"], false);if (buffer.length > 0) this._callEmitter("deliverPartData", partNum, buffer);
      }this._callEmitter("endPart", partNum);
    };MimeParser.prototype._parseHeaders = function () {
      var headers = new StructuredHeaders(this._headerData, this._options);var contentType = headers.get("Content-Type");if (typeof contentType === "undefined") {
        contentType = headerparser.parseStructuredHeader("Content-Type", this._defaultContentType || "text/plain");Object.defineProperty(headers, "contentType", { get: function get() {
            return contentType;
          } });
      } else {
        Object.defineProperty(headers, "contentType", { configurable: false });
      }var charset = "";if (this._options["force-charset"]) charset = this._options["charset"];else if (contentType.has("charset")) charset = contentType.get("charset");else charset = this._options["charset"];headers.charset = charset;this._charset = charset;return headers;
    };MimeParser.prototype._startBody = function Parser_startBody(partNum) {
      var contentType = this._headers.contentType;if (this._options["bodyformat"] == "raw" && partNum == this._options["pruneat"]) {
        this._state = SEND_TO_EMITTER;return;
      }if (contentType.mediatype == "multipart") {
        if (!contentType.has("boundary")) {
          this._state = SEND_TO_BLACK_HOLE;return;
        }this._splitRegex = new RegExp("(\r\n|[\r\n]|^)--" + contentType.get("boundary").replace(/[\\^$*+?.()|{}[\]]/g, "\\$&") + "(--)?[ \t]*(?:\r\n|[\r\n]|$)");this._handleSplit = this._whenMultipart;this._subparser = new MimeParser(this._emitter, this._options);if (contentType.subtype == "digest") this._subparser._defaultContentType = "message/rfc822";this._state = SEND_TO_BLACK_HOLE;this._convertData = function mpart_no_leak_crlf(buffer, more) {
          var splitPoint = buffer.length;if (more) {
            if (buffer.charAt(splitPoint - 1) == "\n") splitPoint--;if (splitPoint >= 0 && buffer.charAt(splitPoint - 1) == "\r") splitPoint--;
          }var res = conditionToEndOnCRLF(buffer.substring(0, splitPoint));var preLF = res[0];var rest = res[1];return [preLF, rest + buffer.substring(splitPoint)];
        };
      } else if (contentType.type == "message/rfc822" || contentType.type == "message/global" || contentType.type == "message/news") {
        this._state = SEND_TO_SUBPARSER;this._subPartNum = partNum + "$";this._subparser = new MimeParser(this._emitter, this._options);var cte = this._extractHeader("content-transfer-encoding", "");if (cte in ContentDecoders) this._convertData = ContentDecoders[cte];
      } else {
        this._state = SEND_TO_EMITTER;if (this._options["bodyformat"] == "decode") {
          var cte = this._extractHeader("content-transfer-encoding", "");if (cte in ContentDecoders) this._convertData = ContentDecoders[cte];
        }
      }if (this._options["strformat"] == "unicode" && contentType.mediatype == "text") {
        if (this._charset !== "") {
          this._decoder = new TextDecoder(this._charset);
        } else {
          this._decoder = { decode: function identity_decoder(buffer) {
              return MimeParser.prototype._coerceData(buffer, "binarystring", true);
            } };
        }
      } else {
        this._decoder = null;
      }
    };MimeParser.prototype._whenMultipart = function (partNum, lastResult) {
      if (partNum != "") partNum += ".";if (!this._subPartNum) {
        this._count = 1;
      } else {
        if (this._savedBuffer != "" && lastResult[1] === "") {
          var useEnd = this._savedBuffer.length - 1;if (this._savedBuffer[useEnd] == "\n") useEnd--;if (useEnd >= 0 && this._savedBuffer[useEnd] == "\r") useEnd--;this._savedBuffer = this._savedBuffer.substring(0, useEnd + 1);
        }if (this._savedBuffer != "") this._subparser._dispatchData(this._subPartNum, this._savedBuffer, true);this._subparser._dispatchEOF(this._subPartNum);
      }this._savedBuffer = "";if (lastResult[2] == undefined) {
        this._subparser.resetParser();this._state = SEND_TO_SUBPARSER;this._subPartNum = partNum + this._count;this._count += 1;
      } else {
        this._splitRegex = null;this._state = SEND_TO_BLACK_HOLE;
      }
    };MimeParser.prototype._extractHeader = function (name, dflt) {
      name = name.toLowerCase();return this._headers.has(name) ? this._headers.get(name) : headerparser.parseStructuredHeader(name, [dflt]);
    };var ContentDecoders = {};ContentDecoders["quoted-printable"] = mimeutils.decode_qp;ContentDecoders["base64"] = mimeutils.decode_base64;return MimeParser;
  });def("headeremitter", function (require) {
    "use strict";var mimeutils = require("./mimeutils");var structuredHeaders = require("./structuredHeaders");var encoders = new Map();var preferredSpellings = structuredHeaders.spellings;var _iteratorNormalCompletion12 = true;var _didIteratorError12 = false;var _iteratorError12 = undefined;try {
      for (var _iterator12 = structuredHeaders.encoders[Symbol.iterator](), _step12; !(_iteratorNormalCompletion12 = (_step12 = _iterator12.next()).done); _iteratorNormalCompletion12 = true) {
        var _step12$value = _slicedToArray(_step12.value, 2);var header = _step12$value[0];var encoder = _step12$value[1];addStructuredEncoder(header, encoder);
      }
    } catch (err) {
      _didIteratorError12 = true;_iteratorError12 = err;
    } finally {
      try {
        if (!_iteratorNormalCompletion12 && _iterator12["return"]) {
          _iterator12["return"]();
        }
      } finally {
        if (_didIteratorError12) {
          throw _iteratorError12;
        }
      }
    }function clamp(value, min, max, def) {
      if (value === undefined) return def;if (value < min) return min;if (value > max) return max;return value;
    }function HeaderEmitter(handler, options) {
      this._useASCII = options.useASCII === undefined ? true : options.useASCII;this._handler = handler;this._currentLine = "";this._softMargin = clamp(options.softMargin, 30, 900, 78);this._hardMargin = clamp(options.hardMargin, this._softMargin, 998, 332);this._preferredBreakpoint = 0;
    }HeaderEmitter.prototype._commitLine = function (count) {
      var isContinuing = typeof count !== "undefined";if (isContinuing) {
        var firstN = this._currentLine.slice(0, count).trimRight();var lastN = this._currentLine.slice(count).trimLeft();
      } else {
        var firstN = this._currentLine.trimRight();var lastN = "";
      }var shift = this._currentLine.length - lastN.length;this._handler.deliverData(firstN + "\r\n");this._currentLine = lastN;if (isContinuing) {
        this._currentLine = " " + this._currentLine;shift++;
      }this._preferredBreakpoint = 0;
    };HeaderEmitter.prototype._reserveTokenSpace = function (length) {
      if (this._currentLine.length + length <= this._softMargin) return true;if (this._preferredBreakpoint > 0) {
        this._commitLine(this._preferredBreakpoint);if (this._currentLine.length + length <= this._softMargin) return true;
      }if (this._currentLine.length + length <= this._hardMargin) {
        return true;
      }if (this._currentLine.length > 0) {
        this._commitLine(this._currentLine.length);
      }return this._currentLine.length + length <= this._hardMargin;
    };HeaderEmitter.prototype.addText = function (text, mayBreakAfter) {
      if (!this._reserveTokenSpace(text.length)) throw new Error("Cannot encode " + text + " due to length.");this._currentLine += text;if (mayBreakAfter) {
        this._preferredBreakpoint = this._currentLine.length;if (text[text.length - 1] != " ") {
          this._currentLine += " ";
        }
      }
    };HeaderEmitter.prototype.addQuotable = function (text, qchars, mayBreakAfter) {
      if (text.length == 0) return;var needsQuote = false;if (!(text[0] == "\"" && text[text.length - 1] == "\"") && qchars != "") {
        for (var i = 0; i < text.length; i++) {
          if (qchars.contains(text[i])) {
            needsQuote = true;break;
          }
        }
      }if (needsQuote) text = "\"" + text.replace(/["\\]/g, "\\$&") + "\"";this.addText(text, mayBreakAfter);
    };HeaderEmitter.prototype.addPhrase = function (text, qchars, mayBreakAfter) {
      text = text.replace(/[ \t\r\n]+/g, " ");if (this._useASCII && nonAsciiRe.test(text)) {
        this.encodeRFC2047Phrase(text, mayBreakAfter);return;
      }if (text.length < this._softMargin) {
        try {
          this.addQuotable(text, qchars, mayBreakAfter);if (this._preferredBreakpoint == 0 && text.contains(" ")) {
            if (this._currentLine[this._currentLine.length - 1] != "\"") this._preferredBreakpoint = this._currentLine.lastIndexOf(" ");
          }return;
        } catch (e) {}
      }var words = text.split(" ");for (var i = 0; i < words.length; i++) {
        this.addQuotable(words[i], qchars, i == words.length - 1 ? mayBreakAfter : true);
      }
    };var nonAsciiRe = /[^\x20-\x7e]/;var b64Prelude = "=?UTF-8?B?",
        qpPrelude = "=?UTF-8?Q?";var qpForbidden = "=?_()\"";var hexString = "0123456789abcdef";HeaderEmitter.prototype._addRFC2047Word = function (encodedText, useQP, mayBreakAfter) {
      var binaryString = mimeutils.typedArrayToString(encodedText);if (useQP) {
        var token = qpPrelude;for (var i = 0; i < encodedText.length; i++) {
          if (encodedText[i] < 32 || encodedText[i] >= 127 || qpForbidden.contains(binaryString[i])) {
            var ch = encodedText[i];token += "=" + hexString[(ch & 240) >> 4] + hexString[ch & 15];
          } else if (binaryString[i] == " ") {
            token += "_";
          } else {
            token += binaryString[i];
          }
        }token += "?=";
      } else {
        var token = b64Prelude + btoa(binaryString) + "?=";
      }this.addText(token, mayBreakAfter);
    };HeaderEmitter.prototype.encodeRFC2047Phrase = function (text, mayBreakAfter) {
      var encodedText = new TextEncoder("UTF-8").encode(text);var minLineLen = b64Prelude.length + 10;if (!this._reserveTokenSpace(minLineLen)) {
        this._commitLine(this._currentLine.length);
      }var b64Len = 0,
          qpLen = 0,
          start = 0;var maxChars = this._softMargin - this._currentLine.length - (b64Prelude.length + 2);for (var i = 0; i < encodedText.length; i++) {
        var b64Inc = 0,
            qpInc = 0;if ((i - start) % 3 == 0) b64Inc += 4;if (encodedText[i] < 32 || encodedText[i] >= 127 || qpForbidden.contains(String.fromCharCode(encodedText[i]))) {
          qpInc = 3;
        } else {
          qpInc = 1;
        }if (b64Len + b64Inc > maxChars && qpLen + qpInc > maxChars) {
          while ((encodedText[i] & 192) == 128) --i;this._addRFC2047Word(encodedText.subarray(start, i), b64Len >= qpLen, true);start = i;--i;b64Len = qpLen = 0;maxChars = this._softMargin - b64Prelude.length - 3;
        } else {
          b64Len += b64Inc;qpLen += qpInc;
        }
      }this._addRFC2047Word(encodedText.subarray(start), b64Len >= qpLen, mayBreakAfter);
    };HeaderEmitter.prototype.addHeaderName = function (name) {
      this._currentLine = this._currentLine.trimRight();if (this._currentLine.length > 0) {
        this._commitLine();
      }this.addText(name + ": ", true);
    };HeaderEmitter.prototype.addStructuredHeader = function (name, value) {
      var lowerName = name.toLowerCase();if (encoders.has(lowerName)) {
        this.addHeaderName(preferredSpellings.get(lowerName));encoders.get(lowerName).call(this, value);
      } else if (typeof value === "string") {
        this.addHeaderName(name);this.addUnstructured(value);
      } else {
        throw new Error("Unknown header " + name);
      }
    };HeaderEmitter.prototype.addAddress = function (addr) {
      if (addr.name) {
        this._reserveTokenSpace(addr.name.length + addr.email.length + 3);this.addPhrase(addr.name, ",()<>:;.\"", true);if (!addr.email) return;this.addText("<", false);
      }var at = addr.email.lastIndexOf("@");var localpart = "",
          domain = "";if (at == -1) localpart = addr.email;else {
        localpart = addr.email.slice(0, at);domain = addr.email.slice(at);
      }this.addQuotable(localpart, "()<>[]:;@\\,\" !", false);this.addText(domain + (addr.name ? ">" : ""), false);
    };HeaderEmitter.prototype.addAddresses = function (addresses) {
      var needsComma = false;var _iteratorNormalCompletion13 = true;var _didIteratorError13 = false;var _iteratorError13 = undefined;try {
        for (var _iterator13 = addresses[Symbol.iterator](), _step13; !(_iteratorNormalCompletion13 = (_step13 = _iterator13.next()).done); _iteratorNormalCompletion13 = true) {
          var addr = _step13.value;if (needsComma) this.addText(", ", true);needsComma = true;if ("email" in addr) {
            this.addAddress(addr);
          } else {
            this.addPhrase(addr.name, ",()<>:;.\"", false);this.addText(":", true);this.addAddresses(addr.group);this.addText(";", true);
          }
        }
      } catch (err) {
        _didIteratorError13 = true;_iteratorError13 = err;
      } finally {
        try {
          if (!_iteratorNormalCompletion13 && _iterator13["return"]) {
            _iterator13["return"]();
          }
        } finally {
          if (_didIteratorError13) {
            throw _iteratorError13;
          }
        }
      }
    };HeaderEmitter.prototype.addUnstructured = function (text) {
      if (text.length == 0) return;this.addPhrase(text, "", false);
    };var kDaysOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];function padTo2Digits(num) {
      return num < 10 ? "0" + num : num.toString();
    }HeaderEmitter.prototype.addDate = function (date) {
      if (isNaN(date.getTime())) throw new Error("Cannot encode an invalid date");if (date.getFullYear() < 1900 || date.getFullYear() > 9999) throw new Error("Date year is out of encodable range");var tzOffset = date.getTimezoneOffset();var tzOffHours = Math.abs(Math.trunc(tzOffset / 60));var tzOffMinutes = Math.abs(tzOffset) % 60;var tzOffsetStr = (tzOffset > 0 ? "-" : "+") + padTo2Digits(tzOffHours) + padTo2Digits(tzOffMinutes);var dayTime = [kDaysOfWeek[date.getDay()] + ",", date.getDate(), mimeutils.kMonthNames[date.getMonth()], date.getFullYear(), padTo2Digits(date.getHours()) + ":" + padTo2Digits(date.getMinutes()) + ":" + padTo2Digits(date.getSeconds()), tzOffsetStr].join(" ");this.addText(dayTime, false);
    };HeaderEmitter.prototype.finish = function (deliverEOF) {
      this._commitLine();if (deliverEOF) this._handler.deliverEOF();
    };function makeStreamingEmitter(handler, options) {
      return new HeaderEmitter(handler, options);
    }function StringHandler() {
      this.value = "";this.deliverData = function (str) {
        this.value += str;
      };this.deliverEOF = function () {};
    }function emitStructuredHeader(name, value, options) {
      var handler = new StringHandler();var emitter = new HeaderEmitter(handler, options);emitter.addStructuredHeader(name, value);emitter.finish(true);return handler.value;
    }function emitStructuredHeaders(headerValues, options) {
      var handler = new StringHandler();var emitter = new HeaderEmitter(handler, options);var _iteratorNormalCompletion14 = true;var _didIteratorError14 = false;var _iteratorError14 = undefined;try {
        var _loop = function _loop() {
          var instance = _step14.value;instance[1].forEach(function (e) {
            emitter.addStructuredHeader(instance[0], e);
          });
        };for (var _iterator14 = headerValues[Symbol.iterator](), _step14; !(_iteratorNormalCompletion14 = (_step14 = _iterator14.next()).done); _iteratorNormalCompletion14 = true) {
          _loop();
        }
      } catch (err) {
        _didIteratorError14 = true;_iteratorError14 = err;
      } finally {
        try {
          if (!_iteratorNormalCompletion14 && _iterator14["return"]) {
            _iterator14["return"]();
          }
        } finally {
          if (_didIteratorError14) {
            throw _iteratorError14;
          }
        }
      }emitter.finish(true);return handler.value;
    }function addStructuredEncoder(header, encoder) {
      var lowerName = header.toLowerCase();encoders.set(lowerName, encoder);if (!preferredSpellings.has(lowerName)) preferredSpellings.set(lowerName, header);
    }return Object.freeze({ addStructuredEncoder: addStructuredEncoder, emitStructuredHeader: emitStructuredHeader, emitStructuredHeaders: emitStructuredHeaders, makeStreamingEmitter: makeStreamingEmitter });
  });def("jsmime", function (require) {
    return { MimeParser: require("./mimeparser"), headerparser: require("./headerparser"), headeremitter: require("./headeremitter") };
  });return mods["jsmime"];
});

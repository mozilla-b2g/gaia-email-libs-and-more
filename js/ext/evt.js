/*
 * evt, an event lib. Version 1.2.0.
 * Copyright 2013-2015, Mozilla Foundation
 *
 * Notable features:
 *
 * - the module itself is an event emitter. Useful for "global" pub/sub.
 * - evt.mix can be used to mix in an event emitter into existing object.
 * - notification of listeners is done in a try/catch, so all listeners
 *   are notified even if one fails.
 * - Errors when notifying listeners in emit() are available via
 *   evt.emit('error'). If there are no error listeners for 'error', then
 *   console.error() is used to log the error with a stack trace.
 * - new evt.Emitter() can be used to create a new instance of an
 *   event emitter.
 * - Uses "this" internally, so always call object with the emitter args.
 * - Allows passing Object, propertyName for listeners, to allow
 *   Object[propertyName].apply(Object, ...) listener calls.
 */
//
(function (root, factory) {
  'use strict';
  if (typeof define === 'function' && define.amd) {
    define(factory);
  } else if (typeof exports === 'object') {
    module.exports = factory();
  } else {
    root.evt = factory();
  }
}(this, function () {
  'use strict';
  var evt,
      slice = Array.prototype.slice,
      props = ['_events', '_pendingEvents', 'on', 'once', 'latest',
               'latestOnce', 'removeObjectListener', 'removeListener',
               'emitWhenListener', 'emit'];

  // Converts possible call styles to a normalized array of:
  // [object, (prop || function)].
  // Handles these cases:
  // (Object, String) -> (Object, String)
  // (Object, Function) -> (Object, Function)
  // (Function, undefined) -> (undefined, Function)
  function objFnPair(obj, fn) {
    if (!fn) {
      fn = obj;
      obj = undefined;
      if (!(fn instanceof Function)) {
        throw new Error('You did not provide a function!');
      }
    } else {
      if (typeof(fn) === 'string') {
        if (!(obj[fn] instanceof Function)) {
          throw new Error(`String ${fn} does not reference a function on obj!`);
        }
      } else if (!(fn instanceof Function)) {
        throw new Error('fn is neither a function or a string!');
      }
    }
    return [obj, fn];
  }

  function callApply(applyPair, args) {
    var obj = applyPair[0],
        fn = applyPair[1];
    if (typeof fn === 'string') {
      fn = obj[fn];
    }
    return fn.apply(obj, args);
  }

  function cleanEventEntry(emitter, id) {
    var listeners = emitter._events[id];
    if (listeners && !listeners.length) {
      delete emitter._events[id];
    }
  }

  // If there is an error listner, delegate to that, otherwise just log the
  // errors, so that emit notifications to other listeners still work.
  function emitError(err) {
    if (evt._events.hasOwnProperty('error')) {
      evt.emit('error', err);
    } else {
      console.error(err, err.stack);
    }
  }

  function Emitter() {
    this._events = {};
    this._pendingEvents = {};
  }

  Emitter.prototype = {
    /**
     * Listen for event. Call signatures:
     * - on(eventId, Function) where undefined will be use as "this"
     *   context when Function is called.
     * - on(eventId, Object, String) where String is a property name on Object.
     *   Object[String] will be called with Object as the "this" context.
     * - on(eventId, Object, Function) where object will be use as "this"
     *   context when Function is called.
     */
    on: function(id, obj, fnName) {
      var applyPair = objFnPair(obj, fnName);

      var listeners = this._events[id],
          pending = this._pendingEvents[id];
      if (!listeners) {
        listeners = this._events[id] = [];
      }
      listeners.push(applyPair);

      if (pending) {
        pending.forEach(function(args) {
          callApply(applyPair, args);
        });
        delete this._pendingEvents[id];
      }
      return this;
    },

    /**
     * Listen for event, but only once, removeListener is automatically called
     * after calling the listener once. Call signatures:
     *
     * Supports same call signatures as on().
     */
    once: function(id, obj, fnName) {
      var self = this,
          fired = false,
          applyPair = objFnPair(obj, fnName);

      function one() {
        if (fired) {
          return;
        }
        fired = true;
        callApply(applyPair, arguments);
        // Remove at a further turn so that the event
        // forEach in emit does not get modified during
        // this turn.
        setTimeout(function() {
          self.removeListener(id, one);
        });
      }
      // Pass object context in case object bulk removeListener before the
      // once is triggered.
      return this.on(id, applyPair[0], one);
    },

    /**
     * Waits for a property on the object that has the event interface
     * to be available. That property MUST EVALUATE TO A TRUTHY VALUE.
     * hasOwnProperty is not used because many objects are created with
     * null placeholders to give a proper JS engine shape to them, and
     * this method should not trigger the listener for those cases.
     * If the property is already available, call the listener right
     * away. If not available right away, listens for an event name that
     * matches the property name.
     *
     * Supports same call signatures as on().
     */
    latest: function(id, obj, fnName) {
      var applyPair = objFnPair(obj, fnName);

      if (this[id] && !this._pendingEvents[id]) {
        callApply(applyPair, [this[id]]);
      }
      this.on(id, applyPair[0], applyPair[1]);
    },

    /**
     * Same as latest, but only calls the listener once.
     *
     * Supports same call signatures as on().
     */
    latestOnce: function(id, obj, fnName) {
      var applyPair = objFnPair(obj, fnName);

      if (this[id] && !this._pendingEvents[id]) {
        callApply(applyPair, [this[id]]);
      } else {
        this.once(id, applyPair[0], applyPair[1]);
      }
    },

    /**
     * Removes all listeners the obj object has for this event emitter.
     * @param  {Object} obj the object that might have listeners for multiple
     * event IDs tracked by this event emitter.
     */
    removeObjectListener: function(obj) {
      Object.keys(this._events).forEach(function(eventId) {
        var listeners = this._events[eventId];

        for (var i = 0; i < listeners.length; i++) {
          var applyPair = listeners[i];
          if (applyPair[0] === obj) {
            listeners.splice(i, 1);
            i -= 1;
          }
        }

        cleanEventEntry(this, eventId);
      }.bind(this));
    },

    /**
     * Removes event listener.
     *
     * Supports same call signatures as on().
     */
    removeListener: function(id, obj, fnName) {
      var listeners = this._events[id],
          applyPair = objFnPair(obj, fnName);

      if (listeners) {
        // Only want to remove the first occurance of the obj/fn pair, so using
        // some() is fine, do not need to iterate over all entries as we try
        // to remove some of them.
        listeners.some(function(listener, i) {
          if (listener[0] === applyPair[0] && listener[1] === applyPair[1]) {
            listeners.splice(i, 1);
            return true;
          }
        });

        cleanEventEntry(this, id);
      }
    },

    /**
     * Like emit, but if no listeners yet, holds on
     * to the value until there is one. Any other
     * args after first one are passed to listeners.
     * @param  {String} id event ID.
     */
    emitWhenListener: function(id) {
      var listeners = this._events[id];
      if (listeners) {
        this.emit.apply(this, arguments);
      } else {
        if (!this._pendingEvents[id]) {
          this._pendingEvents[id] = [];
        }
        this._pendingEvents[id].push(slice.call(arguments, 1));
      }
    },

    emit: function(id) {
      var args = slice.call(arguments, 1),
          listeners = this._events[id];

      if (listeners) {
        // Use a for loop instead of forEach, in case the listener removes
        // itself on the emit notification. In that case need to set the loop
        // index back one.
        for (var i = 0; i < listeners.length; i++) {
          var thisObj = listeners[i][0],
              fn = listeners[i][1];

          try {
            callApply(listeners[i], args);
          } catch (e) {
            emitError(e);
          }

          // If listener removed itself, set the index back a number, so that
          // a subsequent listener does not get skipped.
          if (!listeners[i] ||
            listeners[i][0] !== thisObj ||
            listeners[i][1] !== fn) {
            i -= 1;
          }
        }
      }
    }
  };

  evt = new Emitter();
  evt.Emitter = Emitter;

  /**
   * Mixes in evt methods on the target obj. `evt.Emitter.call(this)` should
   * be called in the obj's constructor function to properly set up instance
   * data used by the evt methods.
   * @param  {Object} obj
   * @return {Object} The obj argument passed in to this function.
   */
  evt.mix = function(obj) {
    var e = new Emitter();
    props.forEach(function(prop) {
      if (obj.hasOwnProperty(prop)) {
        throw new Error('Object already has a property "' + prop + '"');
      }
      obj[prop] = e[prop];
    });
    return obj;
  };

  return evt;
}));

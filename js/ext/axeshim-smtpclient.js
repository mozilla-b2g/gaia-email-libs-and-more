/**
 * Customized shim for browserbox to use 'slog' with configurable logging level
 * that can be cranked up.
 */
define(function() {
'use strict';

let logic = require('logic');
let scope = {};
logic.defineScope(scope, 'smtpclient', {});

return {
  debug: function(ignoredTag, msg) {
    logic(scope, 'debug', { msg: msg });
  },
  log: function(ignoredTag, msg) {
    logic(scope, 'log', { msg: msg });
  },
  warn: function(ignoredTag, msg) {
    logic(scope, 'warn', { msg: msg });
  },
  error: function(ignoredTag, msg) {
    logic(scope, 'error', { msg: msg });
  }
};
});

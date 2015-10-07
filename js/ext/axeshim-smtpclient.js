/**
 * Customized shim for browserbox to use logic with configurable logging level
 * that can be cranked up.
 */
define(function() {
'use strict';

const logic = require('logic');
const scope = logic.scope('SmtpClient');

return {
  // see axeshim-browserbox's comment about '.debug'
  debug: function(ignoredTag, msg) {
    if (!logic.isCensored) {
      logic(scope, 'debug', { msg });
    }
  },
  log: function(ignoredTag, msg) {
    logic(scope, 'log', { msg });
  },
  warn: function(ignoredTag, msg) {
    logic(scope, 'warn', { msg });
  },
  error: function(ignoredTag, msg) {
    logic(scope, 'error', { msg });
  }
};
});

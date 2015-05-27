define(function(require) {
'use strict';

var MailHeader = require('./mail_header');

/**
 * Represents a mail message that matched some search criteria by providing
 * both the header and information about the matches that occurred.
 *
 * XXX search needs to be rebuilt to conform with messages
 */
function MailMatchedHeader(slice, wireRep) {
  this.header = new MailHeader(slice, wireRep.header);
  this.matches = wireRep.matches;

  this.element = null;
  this.data = null;
}
MailMatchedHeader.prototype = {
  toString: function() {
    return '[MailMatchedHeader: ' + this.header.id + ']';
  },
  toJSON: function() {
    return {
      type: 'MailMatchedHeader',
      id: this.header.id
    };
  },

  __update: function(wireRep) {
    this.matches = wireRep.matches;
    this.header.__update(wireRep.header);
  },

  release: function() {
    this.header.release();
  },
};

return MailMatchedHeader;
});

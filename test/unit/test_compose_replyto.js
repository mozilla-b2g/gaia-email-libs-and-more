define(function(require) {

var GelamTest = require('./resources/gelamtest');
var AccountHelpers = require('./resources/account_helpers');
var assert = require('./resources/assert');
var help;

/**
 * Verify that we properly address a reply to a message containing a Reply-To
 * header.
 */
return new GelamTest('Reply-To header is respected', function*(MailAPI) {
  this.group('setup');

  help = new AccountHelpers(MailAPI);
  var account = yield help.createAccount(this.options);
  var folder = yield help.createFolder(
    'reply_to',
    { count: 1, replyTo: 'Reply <reply@example.com>' });
  var slice = yield help.viewFolder(folder);
  var msg = slice.items[0];

  // First, make sure the message includes the reply header we specified:
  assert.deepEqual(
    msg.replyTo,
    [{ name: 'Reply', address: 'reply@example.com' }]);

  // Then, when we reply to that message, the 'To' address should match the
  // value we provided to the Reply-To header (both name and address).
  var composer = yield new Promise((resolve) => {
    var composer = msg.replyToMessage(/* type: */ null, function() {
      resolve(composer);
    });
  });

  assert.deepEqual(composer.to, [{ name: 'Reply',
                                   address: 'reply@example.com' }]);
});

});

define(function(require) {

var GelamTest = require('./resources/gelamtest');
var AccountHelpers = require('./resources/account_helpers');
var assert = require('./resources/assert');
var help;

/**
 * Verify that we properly address a reply to a message containing a Reply-To
 * header.
 */
return new GelamTest('compose round-trips correctly', function*(MailAPI) {
  this.group('setup');

  // Alternately, we could perhaps just slurp up a bunch of JSON definitions?
  var messagesToCompose = [
    {
      name: 'dot stuffing test',
      why: 'end-to-end SMTP dot stuffing verification',
      textBody: `..apple
..banana
...cherry
..crouton
.deli meats
..energy`
    },
  ];

  // -- create the account, get the inbox
  help = new AccountHelpers(MailAPI);
  var account = yield help.createAccount(this.options);
  var inboxFolder = help.folders.getFirstFolderWithType('inbox');
  var inboxView = yield help.viewFolder(inboxFolder);

  for (var iMessage = 0; iMessage < messagesToCompose.length; iMessage++) {
    var messageDef = messagesToCompose[iMessage];

    this.group(messageDef.name);

    // - Create the composer
    var composer = yield new Promise((resolve) => {
      MailAPI.beginMessageComposition(null, inboxFolder, {}, resolve);
    });

    // - Update the composer with the desired state
    // Loopback to this account's identity
    composer.to.push({ address: composer.senderIdentity.address });

    var uniqueSubject = composer.subject = help.makeRandomSubject();

    // We're intentionally not using or working with signatures here; at least
    // for dot-stuffing we don't want the signature stealing the last line case
    // from us.
    composer.body.text = messageDef.textBody;

    // - Send the message
    composer.finishCompositionSendMessage();

    // - Wait for the message to be show up in the folder view
    var header = yield help.waitForMessage(inboxView, uniqueSubject);

    // - Get the body
    var body = yield help.getBody(header, { withBodyReps: true });

    // - Verify the body matches
    assert.equal(
      body.bodyReps[0].content[1],
      messageDef.textBody);
  }
});

});

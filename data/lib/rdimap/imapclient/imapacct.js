/**
 *
 **/

define(
  [
    './imapslice',
    'exports'
  ],
  function(
    $imapslice,
    exports
  ) {

function ImapAccount() {
}
ImapAccount.prototype = {
  sliceFolderMessages: function() {
  },
};

/**
 * Subclasses
 */
function GmailAccount() {
}
GmailAccount.prototype = {
};

}); // end define

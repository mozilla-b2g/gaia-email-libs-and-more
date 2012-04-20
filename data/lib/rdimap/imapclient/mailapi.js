/**
 *
 **/

define(
  [
    'exports'
  ],
  function(
    exports
  ) {

function MailAPI() {
}
MailAPI.prototype = {


  createAccount: function(details) {
  },

  viewAccounts: function() {
  },

  /**
   *
   */
  viewFolders: function() {
  },

  /**
   * Retrieve a slice of the contents of a folder, starting from the most recent
   * messages.
   */
  viewFolderMessages: function(folder) {
  },

  /**
   * Search a folder for messages containing the given text in the sender,
   * recipients, or subject fields, as well as (optionally), the body with a
   * default time constraint so we don't entirely kill the server or us.
   *
   * Expected UX: run the search once without body, then the user can ask for
   * the body search too if the first match doesn't meet their expectations.
   */
  quicksearchFolderMessages: function(folder, text, searchBodyToo) {
  },
};


}); // end define

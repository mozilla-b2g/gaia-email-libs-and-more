/**
 * Test the composition process.
 **/

load('resources/common_mail_api_setup.js');
add_test(setup_mail_api);
add_test(setup_test_account);

/**
 * Compose a new message in one turn of the event loop.
 */
add_test(function test_compose_api_one_shot() {
  var composer = MailAPI.beginMessageComposition(
                   null, gAllFoldersSlice.getFirstFolderWithType('inbox'));

});

/**
 * Start message composition, close out the composition, check that the
 * resulting draft looks like what we expect, resume composition of the
 * draft.
 */
add_test(function test_compose_and_resume() {
});

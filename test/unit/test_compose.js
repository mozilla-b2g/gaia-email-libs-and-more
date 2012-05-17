/**
 * Test the composition process.
 **/

load('resources/common_mail_api_setup.js');
add_test(setup_mail_api);
add_test(setup_test_account);

/**
 * Compose a new message from scratch without saving it to drafts, etc.
 */
add_test(function test_compose_api_one_shot() {
  var composer = MailAPI.beginMessageComposition(
    null, gAllFoldersSlice.getFirstFolderWithType('inbox'), null,
    function composerInitialized() {
      composer.to.push({ name: 'Myself', address: TEST_PARAMS.account });
      composer.subject = 'Dance dance dance!';
      composer.body = 'Antelope banana credenza.\n\nDialog excitement!';

      composer.finishCompositionSendMessage();
    });
});

/**
 * Start message composition, close out the composition, check that the
 * resulting draft looks like what we expect, resume composition of the
 * draft.
 */
//add_test(function test_compose_and_resume() {
//});

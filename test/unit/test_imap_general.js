/**
 * Test our IMAP sync logic under non-pathological conditions.  We exercise
 * logic with a reasonable number of messages.  Test cases that involve folders
 * with ridiculous numbers of messages and/or huge gaps in time which will take
 * a while to run and/or might upset the IMAP servers are handled in
 * `test_imap_excessive.js`.
 **/

load('resources/common_mail_api_setup.js');
add_test(setup_mail_api);
add_test(setup_test_account);

// This does not need to match up with the constant our app actually uses.
const INITIAL_SYNC_DAYS = 7;

/**
 * Try and synchronize an empty folder.  Verify that our slice completes with
 * minimal legwork.
 */
add_imap_folder_test(
  [{ count: 0 }],
  function test_empty_folder_sync(folderPaths, storages, corpuses) {

  run_next_test();
});

/**
 * Perform a folder sync where our initial time fetch window contains all of the
 * messages in the folder.
 */
add_imap_folder_test(
  [{ count: 4 }],
  function test_initial_interval_is_full_sync() {

  run_next_test();
});

/**
 * Perform a folder sync where our initial time fetch window contains more
 * messages than we want and there are even more messages beyond.
 */
add_imap_folder_test(
  [],
  function test_saturated_initial_interval() {

  run_next_test();
});

/**
 * Perform a folder sync where we need to search multiple time ranges in order
 * to gain a sufficient number of messages.
 */
add_imap_folder_test(
  [],
  function test_initial_fetch_spans_multiple_time_ranges() {

  run_next_test();
});


function run_test() {
  run_next_test();
}

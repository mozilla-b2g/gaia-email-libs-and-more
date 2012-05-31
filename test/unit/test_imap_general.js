/**
 * Test our IMAP sync logic under non-pathological conditions.  We exercise
 * logic with a reasonable number of messages.  Test cases that involve folders
 * with ridiculous numbers of messages and/or huge gaps in time which will take
 * a while to run and/or might upset the IMAP servers are handled in
 * `test_imap_excessive.js`.
 *
 * Our tests:
 * - Verify that live synchronization provides the expected results where
 *   the messages come direct from the connection as they are added.
 * -
 **/

load('resources/common_mail_api_setup.js');
add_test(setup_mail_api);
add_test(setup_test_account);

// This does not need to match up with the constant our app actually uses.
const INITIAL_SYNC_DAYS = 7,
      // This is the number of messages after which the sync logic will
      // declare victory and stop filling.
      INITIAL_FILL_SIZE = 15;

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
  [{ count: 4, age: { days: 0 }, age_incr: { days: 1 } }],
  function test_initial_interval_is_full_sync() {

  run_next_test();
});

/**
 * Perform a folder sync where our initial time fetch window contains more
 * messages than we want and there are even more messages beyond.
 */
add_imap_folder_test(
  // This should provide 17 messages in our 7 day range.
  [{ count: 24, age: { days: 0 }, age_incr: { hours: 9 } }],
  function test_saturated_initial_interval() {

  run_next_test();
});

/**
 * Perform a folder sync where we need to search multiple time ranges in order
 * to gain a sufficient number of messages.
 */
add_imap_folder_test(
  // will fetch: 3, 7, 7, 7 = 24
  [{ count: 30, age: { days: 0 }, age_incr: { days: 2 } }],
  function test_initial_fetch_spans_multiple_time_ranges() {

  run_next_test();
});


function run_test() {
  run_next_test();
  do_timeout(5 * 1000, function() { do_throw('Too slow!'); });
}

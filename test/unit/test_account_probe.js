var $mailuniverse = require('rdimap/imapclient/mailuniverse');

/**
 * Verify a probe of testy/testy works for both IMAP and SMTP.
 */
function run_test() {
  do_test_pending();
  var universe = new $mailuniverse.MailUniverse(
    true,
    function bigBanged() {
      console.log('Mail Universe created');
      try {
        universe.tryToCreateAccount(
          {
            username: TEST_PARAMS.account,
            password: TEST_PARAMS.password,
          },
          function accountCreationResult(accountGood) {
            console.log('Account creation result is in:', accountGood);
            do_check_true(accountGood);
            do_test_finished();
          });
      }
      catch (ex) {
        console.error("Exception creating account:", ex, "\n", ex.stack);
        do_throw(ex);
      }
    });
  do_timeout(2 * 1000, function() { do_throw('Too slow!'); });
}

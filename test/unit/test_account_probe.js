var $imapacct = require('rdimap/imapclient/imapacct');

/**
 * Verify a probe of testy/testy works for both IMAP and SMTP.
 */
function run_test() {
  do_test_pending();
  var universe = new $imapacct.MailUniverse(
    true,
    function bigBanged() {
      console.log('Mail Universe created');
      try {
        universe.tryToCreateAccount(
          {
            username: 'testy@localhost',
            password: 'testy'
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
  do_timeout(4 * 1000, function() { do_throw('Too slow!'); });
}

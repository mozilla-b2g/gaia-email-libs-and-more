/**
 *
 **/

define(
  [
    'rdcommon/log',
    'module',
    'exports'
  ],
  function(
    $log,
    $module,
    exports
  ) {

function SmtpAccount(accountId, credentials, connInfo, _parentLog) {
}
exports.SmtpAccount = SmtpAccount;
SmtpAccount.prototype = {

};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  SmtpAccount: {
    type: $log.ACCOUNT,
    events: {
    },
    TEST_ONLY_events: {
    },
    errors: {
      folderAlreadyHasConn: { folderId: false },
    },
  },
});

}); // end define

define(function(require) {

return function main(args, MailAPI) {
  return new Promise(function(resolve, reject) {
    function handled(result) {
      console.warn('** autoconfig result:');
      console.log(JSON.stringify(result, null, 2));
      resolve();
    };

    console.warn('** triggering autoconfig for', args.domain);
    MailAPI.learnAboutAccount({ emailAddress: 'foo@' + args.domain }, handled);
  });
};

}); // end define

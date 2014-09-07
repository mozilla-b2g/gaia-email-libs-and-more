define(function(require) {

return function main(args, MailAPI) {
  return new Promise(function(resolve, reject) {
    function handled(result) {
      console.log(JSON.stringify(result));
      resolve();
    };

    MailAPI.learnAboutAccount({ emailAddress: 'foo@' + args.domain }, handled);
  });
};

}); // end define

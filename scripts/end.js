// config.js will be injected above this comment

// baseUrl is different for front end
require.config({
  baseUrl: 'js/ext'
});

(function () {
  // Send fake API object to allow UI to finish bootstrapping, and finish
  // back-end loading when viewAccounts is called.
  var evtObject = document.createEvent('Event');
  evtObject.initEvent('mailapi', false, false);
  // Create global property too, in case app comes
  // up after the event has fired.
  window.tempMailAPI = evtObject.mailAPI = {
    _fake: true,
    hasAccounts: (document.cookie || '')
                    .indexOf('mailHasAccounts') !== -1,
    useLocalizedStrings: function () {},
    viewAccounts: function () {
      var acctSlice = {
          items: [],
          die: function () {}
      };

      setTimeout(function () {
          if (acctSlice.oncomplete) {
              acctSlice.oncomplete();
          }
          require(['mailapi/main-frame-setup']);
      }, 0);
      return acctSlice;
    }
  };
  window.dispatchEvent(evtObject);
}());


define(function(require) {
'use strict';

let MailHeader = require('./mail_header');
let WindowedListview = require('./windowed_list_view');

function HeadersViewSlice(api, handle, ns) {
  WindowedListView.call(this, api, MailHeader, handle);
}
HeadersViewSlice.prototype = Object.create(WindowedListView.prototype);

return HeadersViewSlice;
});

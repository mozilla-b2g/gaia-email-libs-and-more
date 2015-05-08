define(function(require) {
'use strict';

let WindowedListView = require('./windowed_list_view');
let MailHeader = require('./mail_header');

function HeadersViewSlice(api, handle, ns) {
  WindowedListView.call(this, api, MailHeader, handle);
}
HeadersViewSlice.prototype = Object.create(WindowedListView.prototype);

return HeadersViewSlice;
});


var $imapslice = require('rdimap/imapclient/imapslice');

var storage = new $imapslice.ImapFolderStorage(
  null, 'A-1',
  {
    $meta: {
      id: 'A-1',
      name: 'Inbox',
      path: 'Inbox',
      type: 'inbox'
    },
    $impl: {
      nextHeaderBlock: 0,
      nextBodyBlock: 0,
    },
  },
  null);


function run_test() {
  var blockInfo = storage._makeBodyBlock(1, 2);
  print('blockInfo', JSON.stringify(blockInfo));
}

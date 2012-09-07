const nsIDOMTCPSocket = CC("@mozilla.org/tcp-socket;1",
                     "nsIDOMTCPSocket");
_window_mixin.navigator.mozTCPSocket = new nsIDOMTCPSocket();

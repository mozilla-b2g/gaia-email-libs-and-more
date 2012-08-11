const nsIDOMTCPSocket = CC("@mozilla.org/tcp-socket;1",
                     "nsIDOMTCPSocket");
window.navigator.MozTCPSocket = new nsIDOMTCPSocket();

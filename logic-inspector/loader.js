if (window.parent === window) {
  [
    "./logic-inspector/react-0.13.0.js",
    "./logic-inspector/dom.jsPlumb-1.7.2.js",
    "./logic-inspector/lib/main.js",
    "./logic-inspector/logic-inspector.css"
  ].forEach((src) => {
    if (/.js$/.test(src)) {
      var tag = document.createElement('script');
      tag.src = src;
      tag.async = false;
      document.body.appendChild(tag);
    } else {
      var tag = document.createElement('link');
      tag.rel = 'stylesheet';
      tag.type = 'text/css';
      tag.href = src;
      document.getElementsByTagName('head')[0].appendChild(tag);
    }
  });


  if (window.LATEST_VERSION_POINTER_URL) {
    var originalResponse = null;

    function refreshIfChanged() {
      var lastModified = document.lastModified;
      var xhr = new XMLHttpRequest();
      xhr.open('GET', window.LATEST_VERSION_POINTER_URL, true);
      xhr.overrideMimeType('text/plain');
      xhr.addEventListener('readystatechange', () => {
        if (xhr.readyState !== 4) return;

        if (originalResponse && originalResponse !== xhr.responseText) {
          console.log("Document changed; going to latest version at",
                      xhr.responseText);
          document.location = xhr.responseText;
        } else {
          originalResponse = xhr.responseText;
        }
      });
      xhr.send();
    }

    setInterval(refreshIfChanged, 1000);
  }
}

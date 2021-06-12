define(function() {
'use strict';

return function fillConfigPlaceholders(userDetails, sourceConfigInfo) {
  // Return a mutated copy, don't mutate the original.
  var configInfo = JSON.parse(JSON.stringify(sourceConfigInfo));

  var details = userDetails.emailAddress.split('@');
  var emailLocalPart = details[0], emailDomainPart = details[1];

  var placeholderFields = {
    incoming: ['username', 'hostname', 'server'],
    outgoing: ['username', 'hostname'],
  };

  function fillPlaceholder(value) {
    return value.replace('%EMAILADDRESS%', userDetails.emailAddress)
                .replace('%EMAILLOCALPART%', emailLocalPart)
                .replace('%EMAILDOMAIN%', emailDomainPart)
                .replace('%REALNAME%', userDetails.displayName);
  }

  for (var serverType in placeholderFields) {
    var fields = placeholderFields[serverType];
    var server = configInfo[serverType];
    if (!server) {
      continue;
    }

    for (var iField = 0; iField < fields.length; iField++) {
      var field = fields[iField];

      if (server.hasOwnProperty(field)) {
        server[field] = fillPlaceholder(server[field]);
      }
    }
  }

  return configInfo;
};
});

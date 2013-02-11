/*jslint node: true, nomen: true, evil: true, indent: 2*/
'use strict';

var jsPath, indexPath,
  requirejs = require('./r'),
  fs = require('fs'),
  path = require('path'),
  exists = fs.existsSync || path.existsSync,
  buildOptions = eval(fs.readFileSync(__dirname + '/gaia-email-opt.build.js', 'utf8')),
  oldBuildWrite = buildOptions.onBuildWrite,
  dest = process.argv[2],
  scriptUrls = [];

function mkdir(id) {
  var current,
    parts = id.split('/');

  // Pop off the last part, it is the file name.
  parts.pop();

  parts.forEach(function (part, i) {
    current = path.join.apply(path, [jsPath].concat(parts.slice(0, i + 1)));
    if (!exists(current)) {
      fs.mkdirSync(current, 511);
    }
  });
}

if (!dest || !exists(dest)) {
  console.log('Pass path to gaia destination (should be the apps/email dir ' +
      'inside a gaia directory).');
  process.exit(1);
}

jsPath = path.join(dest, 'js', 'ext');
indexPath = path.join(dest, 'index.html');

// Modify build options to do the file spray
buildOptions.baseUrl = path.join(__dirname, '..');
buildOptions.wrap.startFile = path.join(__dirname, buildOptions.wrap.startFile);
buildOptions.wrap.endFile = path.join(__dirname, buildOptions.wrap.endFile);
buildOptions.out = function (text) { /* ignored */ };
buildOptions.onBuildWrite = function (id, modulePath, contents) {
  var finalPath = path.join(jsPath, id + '.js');
  mkdir(id);

  scriptUrls.push('js/ext/' + id + '.js');

  contents = oldBuildWrite(id, modulePath, contents);

  fs.writeFileSync(finalPath, contents, 'utf8');

  // No need to return contents, since we are not going to save it to an
  // optimized file.
};

requirejs.optimize(buildOptions, function (endText) {

  // Called after all the writing has completed. Write out the script tags.
  var scriptText,
    indexContents = fs.readFileSync(indexPath, 'utf8'),
    startComment = '<!-- START BACKEND INJECT - do not modify -->',
    endComment = '<!-- END BACKEND INJECT -->',
    startIndex = indexContents.indexOf(startComment),
    endIndex = indexContents.indexOf(endComment),
    indent = '  ';

  if (startIndex === -1 || endIndex === -1) {
    console.log('Updating email index.html failed. Cannot find insertion comments.');
    process.exit(1);
  }

  // Copy over the end tag
  fs.createReadStream(path.join(__dirname, '/end.js'))
    .pipe(fs.createWriteStream(path.join(jsPath, 'end.js')));
  scriptUrls.push('js/ext/end.js');

  scriptText = startComment + '\n' +
    scriptUrls.map(function (url) {
      return indent + '<script type="application/javascript;version=1.8" src="' +
        url +
        '"></script>';
    }).join('\n') + '\n' + indent;

  indexContents = indexContents.substring(0, startIndex) +
    scriptText +
    indexContents.substring(endIndex);

  fs.writeFileSync(indexPath, indexContents, 'utf8');
}, function (err) {
  console.error(err);
  process.exit(1);
});


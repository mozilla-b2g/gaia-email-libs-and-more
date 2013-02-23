/*jslint node: true, nomen: true, evil: true, indent: 2*/
'use strict';

var jsPath, currentConfig, indexPath,
  requirejs = require('./r'),
  fs = require('fs'),
  path = require('path'),
  exists = fs.existsSync || path.existsSync,
  buildOptions = eval(fs.readFileSync(__dirname + '/gaia-email-opt.build.js', 'utf8')),
  oldBuildWrite = buildOptions.onBuildWrite,
  dest = process.argv[2],
  layerPaths = {},
  layerTexts = {},
  scriptUrls = {};


function mkdir(id, otherPath) {
  var current,
    parts = id.split('/');

  // Pop off the last part, it is the file name.
  parts.pop();

  parts.forEach(function (part, i) {
    current = path.join.apply(path,
              (otherPath ? [otherPath] : []).concat(parts.slice(0, i + 1)));
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
buildOptions._layerName = 'same-frame-setup';
buildOptions.baseUrl = path.join(__dirname, '..');
buildOptions.wrap.startFile = path.join(__dirname, buildOptions.wrap.startFile);
buildOptions.wrap.endFile = path.join(__dirname, buildOptions.wrap.endFile);
buildOptions.out = function () { /* ignored */ };
buildOptions.onBuildWrite = function (id, modulePath, contents) {
  var finalPath = path.join(jsPath, id + '.js'),
      layerName = currentConfig._layerName;

  if (id === currentConfig.name) {
    layerPaths[currentConfig._layerName] = finalPath;
  }

  if (!scriptUrls[layerName]) {
    scriptUrls[layerName] = [];
  }

  scriptUrls[layerName].push('js/ext/' + id + '.js');

  contents = oldBuildWrite(id, modulePath, contents);

  // A rollup secondary layer
  if (!layerTexts.hasOwnProperty(layerName)) {
    layerTexts[layerName] = '';
  }
  layerTexts[layerName] += contents + '\n';

  // No need to return contents, since we are not going to save it to an
  // optimized file.
};

var standardExcludes = ['mailapi/same-frame-setup'].concat(buildOptions.include);

var configs = [
  // First one is same-frame-setup
  {},

  {
    name: 'mailapi/activesync/configurator',
    exclude: standardExcludes,
    _layerName: 'activesync'
  },

  {
    name: 'mailapi/composite/configurator',
    exclude: standardExcludes,
    _layerName: 'composite'
  },

  {
    name: 'mailapi/fake/configurator',
    exclude: standardExcludes,
    _layerName: 'fake'
  }
];

// Function used to mix in buildOptions to a new config target
function mix(target) {
  for (var prop in buildOptions) {
    if (buildOptions.hasOwnProperty(prop) && !target.hasOwnProperty(prop)) {
      target[prop] = buildOptions[prop];
    }
  }
  return target;
}

function onError(err) {
  console.error(err);
  process.exit(1);
}

//Create a runner that will run a separate build for each item
//in the configs array.
var runner = configs.reduceRight(function (prev, cfg) {
  return function (buildReportText) {
    currentConfig = mix(cfg);

    requirejs.optimize(currentConfig, prev, onError);
  };
}, function (buildReportText) {
  try {
    var scriptText,
      indexContents = fs.readFileSync(indexPath, 'utf8'),
      startComment = '<!-- START BACKEND INJECT - do not modify -->',
      endComment = '<!-- END BACKEND INJECT -->',
      startIndex = indexContents.indexOf(startComment),
      endIndex = indexContents.indexOf(endComment),
      indent = '  ';

    // To see how the layers were partitioned, uncomment
    console.log(scriptUrls);

    // Write out secondary rollups to gaia directory.
    for (var prop in layerPaths) {
      if (layerPaths.hasOwnProperty(prop) && prop !== 'main') {
        mkdir(layerPaths[prop]);
        fs.writeFileSync(layerPaths[prop], layerTexts[prop], 'utf8');
      }
    }

    // Write out the script tags in gaia email index.html
    if (startIndex === -1 || endIndex === -1) {
      console.log('Updating email index.html failed. Cannot find insertion comments.');
      process.exit(1);
    }

    // List of tags used in gaia
    var indexPaths = [
      'alameda',
      'end'
    ];
    fs.createReadStream(path.join(__dirname, '..', 'deps', 'alameda.js'))
      .pipe(fs.createWriteStream(path.join(jsPath, 'alameda.js')));
    fs.createReadStream(path.join(__dirname, 'end.js'))
      .pipe(fs.createWriteStream(path.join(jsPath, 'end.js')));

    scriptText = startComment + '\n' +
      indexPaths.map(function (name) {

        return indent + '<script type="application/javascript;version=1.8" src="' +
          'js/ext/' + name + '.js' +
          '"></script>';
      }).join('\n') + '\n' + indent;

    indexContents = indexContents.substring(0, startIndex) +
      scriptText +
      indexContents.substring(endIndex);

    fs.writeFileSync(indexPath, indexContents, 'utf8');

  } catch (e) {
    console.error(e);
    process.exit(1);
  }
});

//Run the builds
runner();

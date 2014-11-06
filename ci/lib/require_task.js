// Copied environment variables....
var yaml = require('js-yaml');
var mustache = require('mustache');
var fs = require('fs');
var ms = require('ms');
var slugid = require('slugid');

var COPIED_ENVS = [
  'CI',
  'GITHUB_PULL_REQUEST',
  'GITHUB_BASE_REPO',
  'GITHUB_BASE_USER',
  'GITHUB_BASE_GIT',
  'GITHUB_BASE_REV',
  'GITHUB_BASE_BRANCH',
  'GITHUB_HEAD_REPO',
  'GITHUB_HEAD_USER',
  'GITHUB_HEAD_GIT',
  'GITHUB_HEAD_REV',
  'GITHUB_HEAD_BRANCH'
];

function time() {
  return function(text, render) {
    return render(new Date(Date.now() + ms(text)).toJSON());
  }
}

var DOCKER_IMAGE =
  fs.readFileSync(__dirname + '/../docker/DOCKER_TAG', 'utf8').trim() + ':' +
  fs.readFileSync(__dirname + '/../docker/VERSION', 'utf8').trim();

/**
Require a task from the given path and decorate it with variables via mustache.
@param {String} path to file.
@param {Object} variables.
@return {Object} node for the graph.
*/
function requireTask(path, variables) {
  var defaults = {
    time: time,
    gelamDockerImage: DOCKER_IMAGE
  };

  for (var key in variables) defaults[key] = variables[key];

  var content = mustache.render(fs.readFileSync(path, 'utf8'), defaults);
  var node = yaml.load(content);
  var task = node.task;

  node.taskId = node.taskId || slugid.v4();
  task.payload.env = task.payload.env || {};

  // Copy over the environment to sub tasks.
  COPIED_ENVS.forEach(function(env) {
    task.payload.env[env] = process.env[env];
  });

  // Copy treeherder state over so children get shown...
  if (process.env.TREEHERDER_PROJECT && process.env.TREEHERDER_REVISION) {
    task.routes = task.routes || [];
    task.routes.push(
      'treeherder.' +
      process.env.TREEHERDER_PROJECT + '.' +
      process.env.TREEHERDER_REVISION
    );
  }

  return node;
}

module.exports = requireTask;

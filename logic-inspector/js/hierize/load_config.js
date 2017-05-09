import yaml from 'js-yaml';
import fetch from '../fetch';

import { ConfigBuilder } from './config';

/**
 * Interpret our yaml configuation by walking its structure and poking the
 * ConfigBuilder.
 */
function buildFromYaml(rootObj) {
  const builder = new ConfigBuilder();

  const processEventDirectives = (loggerNS, eventName, obj) => {

  };

  const walkLoggerNamespace = (loggerNS) => {

  };


  return builder.finalize();
}

export function loadYamlConfig(configUrl) {
  return fetch(configUrl).then((configStr) => {
    return buildFromYaml(yaml.eval(configStr));
  });
};

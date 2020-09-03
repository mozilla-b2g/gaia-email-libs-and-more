export default async function validatePhabricator({ credentials, typeFields, connInfoFields }) {
  return {
    engineFields: {
      engine: 'phabricator',
      engineData: {},
      receiveProtoConn: null,
    },
  };
}

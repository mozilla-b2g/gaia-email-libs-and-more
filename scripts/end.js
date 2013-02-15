// set location of dynamically loaded layers.
require.config({
    paths: {
        mailapi: 'js/ext/mailapi'
    }
});

// Trigger module resolution for backend to start.
require(['mailapi/same-frame-setup']);

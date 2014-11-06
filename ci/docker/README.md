# Gelam Docker Taskenv

Note this image is currently based on the gaia-taskenv (the entrypoint
is essentially copy/paste with small changes for GELAM).

# Development

## Building the docker image

You need docker (version >= 1.2) installed already (you must be in the
[build/docker/gaia-taskenv](/build/docker/gaia-taskenv) directory.

```sh
./build.sh
```

Name and version are specified via the [DOCKER_TAG](./DOCKER_TAG) file and
[VERSION](./VERSION) files.

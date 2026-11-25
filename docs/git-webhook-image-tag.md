# Git stack webhook image tag

Use `image: registry.example.com/app:${IMAGE_TAG:-latest}` in Compose. Enable the
stack webhook and configure its secret. A CI job can deploy the built image with:

```sh
curl --fail-with-body --show-error -X POST \
  -H "X-Gitlab-Token: ${DOCKHAND_WEBHOOK_SECRET}" \
  "${DOCKHAND_WEBHOOK_URL}?IMAGE_TAG=${CI_COMMIT_SHORT_SHA}"
```

The URL is the stack webhook URL, not the repository webhook. Publish the image
before calling it. An explicit tag updates the stack environment, pulls images,
and deploys even when the Git commit has not changed. An empty tag uses the
saved stack variable, or `latest` if none is saved. A request without the
parameter leaves all variables untouched and keeps the usual Git change
detection, preserving tags supplied by repository environment files. Use
`?IMAGE_TAG=` to explicitly save the fallback and request a pull and deployment.

The saved value is desired configuration: if deployment fails it remains set,
and the webhook returns an error. The stack's saved value overrides a value
with the same name in its Git environment file. Prefer immutable tags such as
commit SHAs for repeatable deploys; publish `latest` too if it is used as fallback.
Protect the webhook secret as a deployment credential. IMAGE_TAG over POST requires
the GitLab token header when a secret is configured: GitHub's HMAC covers the body,
not the URL query. Concurrent Git deployments for the same stack in one Dockhand
process are rejected; webhook callers receive HTTP 409 and may retry later. This
in-process lock does not coordinate multiple Dockhand instances or other direct
Docker operations. A tagged webhook pulls images for the entire Compose stack.

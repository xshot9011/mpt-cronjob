#!/bin/bash

# Exit on any error
set -e

# Run with:
#   AWS_PROFILE=your-profile IMAGE_NAME=mpt-staging-web-scraper sh ./build_image.sh
#   PUSH=false IMAGE_NAME=mpt-staging-web-scraper sh ./build_image.sh   (build only, no ECR push)
## Because I run out of token to accept from argument even it's easy m still lazy la

usage() {
    echo "" >&2
    echo "Usage:" >&2
    echo "  AWS_PROFILE=your-profile IMAGE_NAME=mpt-staging-web-scraper sh ./build_image.sh" >&2
    echo "" >&2
    echo "  IMAGE_NAME   (required) ECR repo / local image name" >&2
    echo "  AWS_PROFILE  (optional) AWS CLI profile; account ID is read from it via 'aws sts get-caller-identity'" >&2
    echo "  PUSH         (optional) 'false' builds only; default pushes both tags to ECR" >&2
}

if [ -z "${IMAGE_NAME}" ]; then
    echo "IMAGE_NAME is not set." >&2
    usage
    exit 1
fi

PUSH="${PUSH:-true}"

# The image installs with `npm ci`, which only trusts the committed lockfile.
if [ ! -f package-lock.json ]; then
    echo "package-lock.json is missing. Run 'npm install' once and commit the lockfile." >&2
    exit 1
fi

IMAGE_TAG="latest"
# Tag on HEAD (e.g. v1.2.3); falls back to the short commit SHA when HEAD isn't tagged.
GIT_TAG=$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)

# aws CLI picks up AWS_PROFILE from the env; placeholder keeps a local build working without creds.
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "YOUR_AWS_ACCOUNT_ID")
if [ "${AWS_ACCOUNT_ID}" = "YOUR_AWS_ACCOUNT_ID" ]; then
    # Fail before the build when the push could never work.
    if [ "${PUSH}" = "true" ]; then
        echo "AWS account not resolved for profile '${AWS_PROFILE:-default}', cannot push to ECR." >&2
        echo "SSO session expired? Run: aws sso login --profile ${AWS_PROFILE:-default}" >&2
        echo "Or build only with PUSH=false." >&2
        usage
        exit 1
    fi
    echo "WARN: AWS account not resolved for profile '${AWS_PROFILE:-default}'. ECR tags will use a placeholder." >&2
    echo "      SSO session expired? Run: aws sso login --profile ${AWS_PROFILE:-default}" >&2
    usage
fi

AWS_REGION="ap-southeast-7"
ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
ECR_REPO="${ECR_REGISTRY}/${IMAGE_NAME}"
echo "=========================================="
echo "Building Container Image: ${IMAGE_NAME}:${IMAGE_TAG} + ${IMAGE_NAME}:${GIT_TAG}"
echo "AWS profile: ${AWS_PROFILE:-default}  account: ${AWS_ACCOUNT_ID}  region: ${AWS_REGION}  push: ${PUSH}"
echo "=========================================="

# 1. Build the image
# We use linux/amd64 architecture; --format docker = Docker v2 manifest (safest for Lambda/ECR)
echo "-> Running podman build..."
# podman build --platform linux/arm64 --format docker -t ${IMAGE_NAME}:${IMAGE_TAG} .
podman build --platform linux/amd64 --format docker \
    -t "${IMAGE_NAME}:${IMAGE_TAG}" \
    -t "${IMAGE_NAME}:${GIT_TAG}" \
    .

echo "-> Tagging image for ECR..."
podman tag "${IMAGE_NAME}:${IMAGE_TAG}" "${ECR_REPO}:${IMAGE_TAG}"
podman tag "${IMAGE_NAME}:${IMAGE_TAG}" "${ECR_REPO}:${GIT_TAG}"

echo "=========================================="
echo "Build Successful!"
echo "=========================================="

if [ "${PUSH}" != "true" ]; then
    echo "PUSH=${PUSH}: skipped the ECR push (run without PUSH=false to push)."
    echo ""
    echo "To test locally, run:"
    echo "  podman run --platform linux/amd64 -p 9000:8080 -e CONFIG_JSON=\"\$(cat examples/get-xpath.json)\" ${IMAGE_NAME}:${IMAGE_TAG}"
    echo "  curl -XPOST \"http://localhost:9000/2015-03-31/functions/function/invocations\" -d '{}'"
    exit 0
fi

# 2. Push to ECR
# If get-login-password fails, podman login gets an empty password and fails too, so set -e stops here.
echo "-> Logging in to ECR..."
aws ecr get-login-password --region "${AWS_REGION}" \
    | podman login --username AWS --password-stdin "${ECR_REGISTRY}"

echo "-> Pushing image to ECR..."
podman push "${ECR_REPO}:${IMAGE_TAG}"
podman push "${ECR_REPO}:${GIT_TAG}"

echo "=========================================="
echo "Push Successful!"
echo "  ${ECR_REPO}:${IMAGE_TAG}"
echo "  ${ECR_REPO}:${GIT_TAG}"
echo "Deploy it with image_tag = \"${GIT_TAG}\" in terragrunt."
echo "=========================================="

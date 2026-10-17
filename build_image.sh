#!/bin/bash

# Exit on any error
set -e

# Run with:
#   AWS_PROFILE=your-profile IMAGE_NAME=mpt-staging-web-scraper sh ./build_image.sh
## Because I run out of token to accept from argument even it's easy m still lazy la

usage() {
    echo "" >&2
    echo "Usage:" >&2
    echo "  AWS_PROFILE=your-profile IMAGE_NAME=mpt-staging-web-scraper sh ./build_image.sh" >&2
    echo "" >&2
    echo "  IMAGE_NAME   (required) ECR repo / local image name" >&2
    echo "  AWS_PROFILE  (optional) AWS CLI profile; account ID is read from it via 'aws sts get-caller-identity'" >&2
}

if [ -z "${IMAGE_NAME}" ]; then
    echo "IMAGE_NAME is not set." >&2
    usage
    exit 1
fi

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
    echo "WARN: AWS account not resolved for profile '${AWS_PROFILE:-default}'. ECR tags will use a placeholder." >&2
    echo "      SSO session expired? Run: aws sso login --profile ${AWS_PROFILE:-default}" >&2
    usage
fi

AWS_REGION="ap-southeast-7"
ECR_REPO="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${IMAGE_NAME}"
echo "=========================================="
echo "Building Container Image: ${IMAGE_NAME}:${IMAGE_TAG} + ${IMAGE_NAME}:${GIT_TAG}"
echo "AWS profile: ${AWS_PROFILE:-default}  account: ${AWS_ACCOUNT_ID}  region: ${AWS_REGION}"
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
echo "To test locally, run:"
echo "  podman run --platform linux/amd64 -p 9000:8080 -e CONFIG_JSON=\"\$(cat examples/get-xpath.json)\" ${IMAGE_NAME}:${IMAGE_TAG}"
echo "  curl -XPOST \"http://localhost:9000/2015-03-31/functions/function/invocations\" -d '{}'"
echo ""
echo "To push to AWS ECR, run:"
echo "  aws ecr get-login-password --region ${AWS_REGION} ${AWS_PROFILE:+--profile ${AWS_PROFILE}} | podman login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
echo ""
echo "  podman push ${ECR_REPO}:${IMAGE_TAG}"
echo "  podman push ${ECR_REPO}:${GIT_TAG}"

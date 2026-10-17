#!/bin/bash

# Exit on any error
set -e

# IMAGE_NAME= run with IMAGE_NAME=xxxxxxx sh ./build_image.sh
## Because I run out of token to accept from argument even it's easy m still lazy la

: "${IMAGE_NAME:?Set IMAGE_NAME, e.g. IMAGE_NAME=mpt-staging-web-scraper ./build_image.sh}"

# The image installs with `npm ci`, which only trusts the committed lockfile.
if [ ! -f package-lock.json ]; then
    echo "package-lock.json is missing. Run 'npm install' once and commit the lockfile." >&2
    exit 1
fi

IMAGE_TAG="latest"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "YOUR_AWS_ACCOUNT_ID")
AWS_REGION="ap-southeast-7"
ECR_REPO="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${IMAGE_NAME}"
echo "=========================================="
echo "Building Container Image: ${IMAGE_NAME}:${IMAGE_TAG}"
echo "=========================================="

# 1. Build the Docker image
# We use linux/amd64 architecture
echo "-> Running docker build..."
# docker build --platform linux/arm64 -t ${IMAGE_NAME}:${IMAGE_TAG} .
docker build --platform linux/amd64 -t ${IMAGE_NAME}:${IMAGE_TAG} .

echo "-> Tagging image for ECR..."
docker tag ${IMAGE_NAME}:${IMAGE_TAG} ${ECR_REPO}:${IMAGE_TAG}

echo "=========================================="
echo "Build Successful!"
echo "=========================================="
echo "To test locally, run:"
echo "  docker run --platform linux/amd64 -p 9000:8080 -e CONFIG_JSON=\"\$(cat examples/get-xpath.json)\" ${IMAGE_NAME}:${IMAGE_TAG}"
echo "  curl -XPOST \"http://localhost:9000/2015-03-31/functions/function/invocations\" -d '{}'"
echo ""
echo "To push to AWS ECR, run:"
echo "  aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
echo ""
echo "  docker push ${ECR_REPO}:${IMAGE_TAG}"

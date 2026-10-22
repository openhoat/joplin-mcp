#!/bin/bash
set -e

# Change to script directory so Docker finds the Dockerfile
cd "$(dirname "$0")"

REGISTRY="${JOPLIN_MCP_DOCKER_REGISTRY:-ghcr.io/openhoat}"
IMAGE="${REGISTRY}/joplin-mcp"
VERSION="${JOPLIN_MCP_VERSION:-latest}"

echo "Building joplin-mcp:${VERSION}..."
docker buildx build \
  --builder joplin-mcp-builder \
  --platform linux/amd64,linux/arm64 \
  -t "${IMAGE}:${VERSION}" \
  -t "${IMAGE}:latest" \
  --push \
  .

echo "✅ Done! Image ${IMAGE}:${VERSION} pushed."

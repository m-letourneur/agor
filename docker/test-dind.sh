#!/bin/bash
# Test script to verify Docker-in-Docker setup

set -e

echo "========================================="
echo "Testing Docker-in-Docker Setup"
echo "========================================="
echo ""

# Test 1: Docker CLI available
echo "✓ Test 1: Docker CLI installed"
docker --version || { echo "✗ FAIL: docker command not found"; exit 1; }
docker compose version || { echo "✗ FAIL: docker compose plugin not found"; exit 1; }
echo ""

# Test 2: Docker daemon accessible
echo "✓ Test 2: Docker daemon accessible"
docker ps > /dev/null || { echo "✗ FAIL: cannot connect to Docker daemon"; exit 1; }
docker info > /dev/null || { echo "✗ FAIL: docker info failed"; exit 1; }
echo ""

# Test 3: Can list containers
echo "✓ Test 3: Can list containers"
CONTAINER_COUNT=$(docker ps -q | wc -l)
echo "  Found ${CONTAINER_COUNT} running container(s)"
echo ""

# Test 4: Can start a test container
echo "✓ Test 4: Can start test container"
docker run --rm --name dind-test alpine:latest echo "Hello from test container" || {
  echo "✗ FAIL: could not start test container"
  exit 1
}
echo ""

# Test 5: User is in docker group
echo "✓ Test 5: User permissions"
CURRENT_USER=$(whoami)
GROUPS=$(groups)
echo "  Current user: ${CURRENT_USER}"
echo "  Groups: ${GROUPS}"
if echo "${GROUPS}" | grep -q docker; then
  echo "  ✓ User is in docker group"
else
  echo "  ⚠ Warning: User not in docker group (may not persist across shells)"
fi
echo ""

echo "========================================="
echo "All tests passed! ✓"
echo "Docker-in-Docker is working correctly."
echo "========================================="

# Implementation Diff: Docker-in-Docker Support

This file contains the exact code changes needed to implement simple Docker-in-Docker support for Agor worktrees.

---

## File 1: docker/Dockerfile

### Change Location
After line 33 (after `acl` package, before `rm -rf /var/lib/apt/lists/*`)

### Before
```dockerfile
RUN apt-get update && apt-get install -y \
  sqlite3 \
  git \
  curl \
  sudo \
  vim \
  procps \
  htop \
  lsof \
  net-tools \
  iputils-ping \
  wget \
  jq \
  less \
  tree \
  openssh-server \
  acl \
  && rm -rf /var/lib/apt/lists/*
```

### After
```dockerfile
RUN apt-get update && apt-get install -y \
  sqlite3 \
  git \
  curl \
  sudo \
  vim \
  procps \
  htop \
  lsof \
  net-tools \
  iputils-ping \
  wget \
  jq \
  less \
  tree \
  openssh-server \
  acl \
  ca-certificates \
  gnupg \
  lsb-release \
  && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (for worktree environments that use docker compose)
# This enables worktrees to run their own Docker Compose environments
# by communicating with the host Docker daemon via mounted socket
RUN install -m 0755 -d /etc/apt/keyrings && \
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
  chmod a+r /etc/apt/keyrings/docker.gpg && \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list && \
  apt-get update && \
  apt-get install -y docker-ce-cli docker-compose-plugin && \
  rm -rf /var/lib/apt/lists/*

# Verify Docker CLI installation
RUN docker --version && docker compose version
```

**Explanation:**
- Adds Docker dependencies: `ca-certificates`, `gnupg`, `lsb-release`
- Installs official Docker CLI from Docker's APT repository
- Installs Docker Compose v2 plugin (`docker compose` not `docker-compose`)
- Verifies installation to catch build-time errors

---

## File 2: docker-compose.yml

### Change Location
In `agor-dev` service, `volumes` section (after line 156)

### Before
```yaml
services:
  agor-dev:
    # ... config ...
    volumes:
      # Mount entire repo for hot-reload (source code only)
      - .:/app
      # Anonymous volume shadows bind mount, preserving Docker-built node_modules
      - /app/node_modules
      # Shadow package-level node_modules too
      - /app/packages/core/node_modules
      - /app/packages/executor/node_modules
      - /app/apps/agor-daemon/node_modules
      - /app/apps/agor-cli/node_modules
      - /app/apps/agor-ui/node_modules
      # Persist entire home directory
      - agor-home:/home/agor
      # Mount SSH keys for git authentication
      - ~/.ssh:/home/agor/.ssh:ro
    stdin_open: true
    tty: true
```

### After
```yaml
services:
  agor-dev:
    # ... config ...
    volumes:
      # Mount entire repo for hot-reload (source code only)
      - .:/app
      # Anonymous volume shadows bind mount, preserving Docker-built node_modules
      - /app/node_modules
      # Shadow package-level node_modules too
      - /app/packages/core/node_modules
      - /app/packages/executor/node_modules
      - /app/apps/agor-daemon/node_modules
      - /app/apps/agor-cli/node_modules
      - /app/apps/agor-ui/node_modules
      # Persist entire home directory
      - agor-home:/home/agor
      # Mount SSH keys for git authentication
      - ~/.ssh:/home/agor/.ssh:ro
      # Mount Docker socket for worktree environments
      # Enables worktrees to run docker compose commands
      # Note: This gives Agor container access to host Docker daemon
      - /var/run/docker.sock:/var/run/docker.sock
    stdin_open: true
    tty: true
```

**Explanation:**
- Mounts host Docker socket into container at same path
- Enables Docker CLI to communicate with host daemon
- Read-write mount (required for Docker commands)
- Security note in comment for transparency

---

## File 3: docker/docker-entrypoint.sh

### Change Location
After the shebang and `set -e`, before existing code (around line 3)

### Before
```bash
#!/bin/bash
set -e

# Wait for database to be ready (if using PostgreSQL)
# ... rest of script ...
```

### After
```bash
#!/bin/bash
set -e

# ============================================================================
# Docker Socket Access (for worktree environments)
# ============================================================================
# When docker.sock is mounted, ensure the 'agor' user can access it.
# The socket is owned by the host's 'docker' group (typically GID 999 or similar).
# We add the 'agor' user to a group matching the socket's GID.
#
# This enables worktrees to run docker compose commands for their environments.
# Without this setup, Docker CLI commands would fail with "permission denied".

if [ -S /var/run/docker.sock ]; then
  echo "[entrypoint] Docker socket detected, configuring access..."

  # Get the GID of the docker.sock
  DOCKER_SOCK_GID=$(stat -c '%g' /var/run/docker.sock)
  echo "[entrypoint] Docker socket GID: ${DOCKER_SOCK_GID}"

  # Create a docker group with matching GID (if it doesn't exist)
  if ! getent group ${DOCKER_SOCK_GID} > /dev/null 2>&1; then
    sudo groupadd -g ${DOCKER_SOCK_GID} docker
    echo "[entrypoint] Created docker group with GID ${DOCKER_SOCK_GID}"
  else
    GROUP_NAME=$(getent group ${DOCKER_SOCK_GID} | cut -d: -f1)
    echo "[entrypoint] Group with GID ${DOCKER_SOCK_GID} already exists: ${GROUP_NAME}"
  fi

  # Add agor user to the docker group
  sudo usermod -aG ${DOCKER_SOCK_GID} agor
  echo "[entrypoint] Added 'agor' user to docker group (GID ${DOCKER_SOCK_GID})"

  # Verify access (this command should NOT error)
  # Note: We need to use 'sg' to activate the new group membership in this shell
  if sg ${DOCKER_SOCK_GID} -c 'docker ps' > /dev/null 2>&1; then
    echo "[entrypoint] ✓ Docker socket access verified"
  else
    echo "[entrypoint] ⚠ Warning: Docker socket access may not be working"
    echo "[entrypoint] Debugging info:"
    ls -la /var/run/docker.sock || echo "  Socket not found"
    groups agor || echo "  Could not get groups for agor user"
  fi
else
  echo "[entrypoint] No Docker socket mounted (worktree docker compose environments will not be available)"
  echo "[entrypoint] To enable Docker-in-Docker, add to docker-compose.yml:"
  echo "[entrypoint]   volumes:"
  echo "[entrypoint]     - /var/run/docker.sock:/var/run/docker.sock"
fi

echo ""  # Blank line for readability

# Wait for database to be ready (if using PostgreSQL)
# ... rest of existing script ...
```

**Explanation:**
- Runs at container startup, before daemon/UI start
- Detects if Docker socket is mounted (graceful if not)
- Gets socket's GID from host (varies by system)
- Creates matching group and adds `agor` user
- Verifies access with test command
- Provides helpful error messages and debugging info
- Clear guidance if socket not mounted

**Important:** The `sg` command is used for verification because `usermod -aG` doesn't affect current shell sessions. New shells/processes will have access automatically.

---

## File 4: docker/docker-entrypoint-prod.sh (Optional)

### If Production Image Needs Docker Support

Apply the same Docker socket access block as in `docker-entrypoint.sh` (lines 5-40).

**Location:** After shebang, before existing code

Same code as shown above for dev entrypoint.

---

## Testing Verification Script

### Create: docker/test-dind.sh (New File)

```bash
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
```

**Usage:**
```bash
# After rebuilding and starting Agor
docker compose exec agor-dev bash /app/docker/test-dind.sh
```

---

## Build and Deploy Commands

```bash
# 1. Rebuild Docker image with new changes
docker compose build --no-cache

# 2. Start Agor with new configuration
docker compose up -d

# 3. Verify Docker access
docker compose exec agor-dev docker ps

# 4. Run comprehensive test
docker compose exec agor-dev bash /app/docker/test-dind.sh

# 5. Check logs for entrypoint output
docker compose logs agor-dev | grep entrypoint
# Should see: "Docker socket access verified"
```

---

## Rollback Plan

If something breaks:

```bash
# 1. Stop containers
docker compose down

# 2. Revert changes
git checkout HEAD -- docker/Dockerfile docker-compose.yml docker/docker-entrypoint.sh

# 3. Rebuild original image
docker compose build

# 4. Restart
docker compose up -d
```

---

## Summary of Changes

| File | Lines Changed | Purpose |
|------|---------------|---------|
| `docker/Dockerfile` | +17 lines | Install Docker CLI + Compose plugin |
| `docker-compose.yml` | +4 lines | Mount Docker socket |
| `docker/docker-entrypoint.sh` | +40 lines | Configure socket permissions |
| **Total** | **~60 lines** | Simple, minimal, focused |

**No changes needed:**
- ❌ Application code (TypeScript/React)
- ❌ Database schema
- ❌ API endpoints
- ❌ Environment config templates (already use `docker compose`)
- ❌ Port allocation logic (already works)

**Why so simple:**
Because Agor's environment config system was designed with this in mind! The `.agor.yml` files already have `docker compose` commands—we just needed to make Docker available. 🎉

---

## Next Steps After Implementation

1. **Update Documentation**
   - Add Docker socket requirement to installation guide
   - Document security implications
   - Add examples for common docker-compose.yml patterns

2. **User Communication**
   - Changelog entry
   - Migration guide (just rebuild image)
   - Security advisory (Docker socket access)

3. **Future Enhancements**
   - Docker socket proxy for better security
   - Automatic network configuration
   - Resource limits (CPU/memory quotas)
   - Cleanup job for stopped containers

---

**Questions?**
- Full design rationale: `DESIGN-SIMPLE-DIND.md`
- Quick reference: `DIND-QUICK-REFERENCE.md`
- This file: Concrete implementation changes

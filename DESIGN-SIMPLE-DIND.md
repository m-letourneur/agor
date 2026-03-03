# Design: Simple Docker-in-Docker for Worktree Environments

**Status:** Design Document
**Date:** 2026-03-03
**Repository:** m-letourneur/agor

---

## Executive Summary

Enable Agor worktrees to run their own Docker Compose environments while Agor itself runs in Docker. This is the **simplest possible approach** using Docker socket mounting—a standard DinD pattern used by CI/CD systems worldwide.

**Key Insight:** Agor's existing `.agor.yml` template already uses `docker compose` commands! We just need to make Docker available inside the Agor container.

---

## Current State Analysis

### What Exists Today

1. **Environment Config Template System** ✅
   - Repos have `environment_config` with Handlebars templates
   - Commands: `up_command`, `down_command`, `nuke_command`, `logs_command`
   - Port allocation: `{{add 3000 worktree.unique_id}}` pattern
   - Health checks and app URLs templated

2. **Agor's Own `.agor.yml`** ✅
   ```yaml
   environment:
     start: DAEMON_PORT={{add 3000 worktree.unique_id}} UI_PORT={{add 5000 worktree.unique_id}} docker compose -p agor-{{worktree.name}} up -d
     stop: docker compose -p agor-{{worktree.name}} down
     health: http://localhost:{{add 3000 worktree.unique_id}}/health
     app: http://localhost:{{add 5000 worktree.unique_id}}
     logs: docker compose -p agor-{{worktree.name}} logs --tail=100
   ```

3. **Current Blocker** ❌
   - Docker CLI not installed in Agor container
   - Docker socket not mounted
   - **Result:** Commands fail with "docker: command not found"

---

## Architecture: Docker Socket Mounting

### The Pattern

This is a **standard Docker-in-Docker pattern** used by:
- GitLab Runner (CI/CD)
- Jenkins (CI/CD)
- Portainer (Docker management UI)
- Many development environments

**How it works:**
1. Mount host's Docker socket into Agor container: `/var/run/docker.sock`
2. Install Docker CLI in Agor container
3. Docker CLI communicates with host Docker daemon via socket
4. **Result:** Container can start sibling containers (not nested—siblings!)

### Important Clarification

This is NOT "Docker-in-Docker" (DinD) in the technical sense. It's **"Docker-from-Docker"**:
- ❌ NOT running a Docker daemon inside Docker
- ✅ Running Docker CLI inside Docker that talks to host daemon
- All containers are siblings on the same Docker network

**Visual:**
```
Host Docker Daemon
  ├── Agor Container (has Docker CLI, socket access)
  ├── Worktree 1 Environment (started by Agor via socket)
  ├── Worktree 2 Environment (started by Agor via socket)
  └── PostgreSQL (optional, started by Agor's docker-compose.yml)
```

---

## Implementation Plan

### 1. Docker CLI Installation (Dockerfile)

**File:** `docker/Dockerfile`

**Changes needed in base stage:**

```dockerfile
# Stage 1: Shared Base (dev and prod both use this)
FROM node:20-slim AS base

# Install system dependencies (including git for repo cloning)
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
  # ADD THESE LINES FOR DOCKER CLI:
  ca-certificates \
  gnupg \
  lsb-release \
  && rm -rf /var/lib/apt/lists/*

# ADD THIS BLOCK TO INSTALL DOCKER CLI:
# Install Docker CLI (for worktree environments that use docker compose)
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

**Why this approach:**
- Uses official Docker repository (latest stable CLI)
- Installs both `docker` and `docker compose` plugin
- Clean APT cache for smaller image
- Single layer for efficiency

### 2. Docker Socket Mounting (docker-compose.yml)

**File:** `docker-compose.yml`

**Changes needed in agor-dev service:**

```yaml
services:
  agor-dev:
    # ... existing config ...
    volumes:
      # ... existing volumes ...

      # ADD THIS LINE:
      # Mount Docker socket for worktree environments
      - /var/run/docker.sock:/var/run/docker.sock
```

**Important notes:**
- **Security consideration:** Mounting Docker socket gives container full Docker host access
- **For dev environments:** This is acceptable (developer trust model)
- **For production:** Consider alternatives or additional restrictions (out of scope for "simple" design)
- **User permissions:** The `agor` user needs access to Docker socket (see below)

### 3. Docker Socket Permissions (Entrypoint Script)

**File:** `docker/docker-entrypoint.sh`

**Add this block at the beginning** (after shebang, before other setup):

```bash
#!/bin/bash
set -e

# ============================================================================
# Docker Socket Access (for worktree environments)
# ============================================================================
# When docker.sock is mounted, ensure the 'agor' user can access it.
# The socket is owned by the host's 'docker' group (typically GID 999 or similar).
# We add the 'agor' user to a group matching the socket's GID.

if [ -S /var/run/docker.sock ]; then
  echo "[entrypoint] Docker socket detected, configuring access..."

  # Get the GID of the docker.sock
  DOCKER_SOCK_GID=$(stat -c '%g' /var/run/docker.sock)
  echo "[entrypoint] Docker socket GID: ${DOCKER_SOCK_GID}"

  # Create a docker group with matching GID (if it doesn't exist)
  if ! getent group ${DOCKER_SOCK_GID} > /dev/null 2>&1; then
    sudo groupadd -g ${DOCKER_SOCK_GID} docker
    echo "[entrypoint] Created docker group with GID ${DOCKER_SOCK_GID}"
  fi

  # Add agor user to the docker group
  sudo usermod -aG ${DOCKER_SOCK_GID} agor
  echo "[entrypoint] Added 'agor' user to docker group (GID ${DOCKER_SOCK_GID})"

  # Verify access (this command should NOT error)
  if docker ps > /dev/null 2>&1; then
    echo "[entrypoint] ✓ Docker socket access verified"
  else
    echo "[entrypoint] ⚠ Warning: Docker socket access may not be working"
  fi
else
  echo "[entrypoint] No Docker socket mounted (worktree docker compose environments will not work)"
fi

# ... rest of existing entrypoint script ...
```

**Why this approach:**
- Handles dynamic GID (varies by host system)
- Idempotent (safe to run multiple times)
- Clear logging for debugging
- Graceful when socket not mounted (dev without Docker environments)

### 4. No Changes Needed ✅

The following already work correctly:

**Port Allocation:**
- Template: `DAEMON_PORT={{add 3000 worktree.unique_id}}`
- Renders to: `DAEMON_PORT=3001`, `DAEMON_PORT=3002`, etc.
- Works perfectly for sibling containers!

**Volume/Path Handling:**
- Worktree paths: `/home/agor/.agor/worktrees/{repo-slug}/{name}`
- These paths exist inside Agor container
- Sibling containers can bind mount them using same paths (shared host filesystem)

**Example docker-compose.yml in a worktree:**
```yaml
# This lives in /home/agor/.agor/worktrees/agor/my-feature/docker-compose.yml
services:
  app:
    build: .
    ports:
      - "${DAEMON_PORT:-3030}:3030"  # Template sets this via env
      - "${UI_PORT:-5173}:5173"
    volumes:
      - .:/app  # Relative path works (we're in worktree dir)
```

**When Agor runs:** `docker compose -p agor-my-feature up -d`
- Environment variables set by template (`DAEMON_PORT=3001`, `UI_PORT=5001`)
- Docker CLI talks to host daemon via socket
- Creates sibling container with unique project name
- Bind mounts work because paths are on shared host filesystem

---

## Testing Approach

### Phase 1: Verify Docker Access

```bash
# Build and start Agor
docker compose build
docker compose up -d

# Exec into container
docker compose exec agor-dev bash

# Verify Docker CLI
docker --version
docker compose version

# Verify socket access
docker ps  # Should show running containers (including agor-dev itself!)
```

### Phase 2: Test Worktree Environment

```bash
# Create a test worktree (via CLI or UI)
pnpm agor worktree create agor test-dind --board-id <board-id>

# Start environment via API or UI
curl -X POST http://localhost:3030/environment/start \
  -H "Content-Type: application/json" \
  -d '{"worktree_id": "<worktree-id>"}'

# Verify sibling containers
docker ps | grep agor-test-dind

# Check logs
docker compose -p agor-test-dind logs
```

### Phase 3: Validate Port Isolation

```bash
# Create multiple worktrees
pnpm agor worktree create agor wt-1 --board-id <board-id>
pnpm agor worktree create agor wt-2 --board-id <board-id>

# Start both environments
# Verify unique ports (3001/5001, 3002/5002, etc.)
docker ps --format "table {{.Names}}\t{{.Ports}}"

# Access both UIs simultaneously
curl http://localhost:5001  # wt-1
curl http://localhost:5002  # wt-2
```

---

## Known Limitations

### 1. Security Considerations

**Issue:** Mounting Docker socket = full host access
**Impact:** Container can start any container, access all Docker resources
**Mitigation (future):**
- Docker socket proxy (restrict allowed commands)
- Rootless Docker (user namespace isolation)
- SELinux/AppArmor profiles

**For now:** Document this clearly in setup guide, acceptable for dev/single-user

### 2. Network Complexity

**Issue:** Sibling containers are on different Docker networks
**Impact:** Worktree containers can't directly reach each other via container names
**Workaround:** Use `host.docker.internal` or explicit network configuration
**Example:**
```yaml
# In worktree docker-compose.yml
networks:
  default:
    external: true
    name: agor_default  # Join Agor's network
```

### 3. Filesystem Path Assumptions

**Issue:** Sibling containers must use same absolute paths as Agor container
**Impact:** Bind mounts in worktree docker-compose.yml must use container paths, not host paths
**Example (works):**
```yaml
volumes:
  - .:/app  # Relative path (always safe)
  - /home/agor/.agor/worktrees/agor/my-feature:/app  # Absolute (container path)
```
**Example (breaks):**
```yaml
volumes:
  - ~/code/my-repo:/app  # Host user's home dir (not accessible!)
```

### 4. Resource Management

**Issue:** No automatic cleanup of stopped worktree containers
**Impact:** `docker ps -a` fills up with stopped containers
**Workaround:** Use `docker compose down` (stop command) instead of just stopping
**Future:** Implement periodic cleanup job

### 5. Docker Compose Version Compatibility

**Issue:** Worktree docker-compose.yml files may use different versions
**Impact:** Syntax errors if worktree uses newer features
**Current state:** Installing latest Docker CLI (supports v2 compose syntax)
**Mitigation:** Document minimum version requirements in `.agor.yml` examples

---

## Implementation Checklist

- [ ] Update `docker/Dockerfile` to install Docker CLI
- [ ] Update `docker-compose.yml` to mount Docker socket
- [ ] Update `docker/docker-entrypoint.sh` for socket permissions
- [ ] Rebuild Docker image: `docker compose build`
- [ ] Test basic Docker access inside container
- [ ] Create test worktree with docker compose config
- [ ] Verify environment start/stop/logs commands
- [ ] Test multiple worktrees with unique ports
- [ ] Document limitations in README or setup guide
- [ ] Add troubleshooting section for common issues

---

## Future Enhancements (Out of Scope)

### Better Isolation
- Docker socket proxy (e.g., Tecnativa's docker-socket-proxy)
- Rootless Docker support
- Container resource limits (CPU/memory)

### Better Networking
- Automatic network bridging between worktrees
- Service discovery for inter-worktree communication
- Reverse proxy for unified URLs

### Better Resource Management
- Auto-cleanup of stopped containers
- Disk usage monitoring
- Container lifecycle hooks

### Advanced Features
- Kubernetes support (replace Docker Compose)
- Remote Docker daemon support
- Multi-host orchestration

---

## Questions & Answers

**Q: Why not use actual Docker-in-Docker (dind)?**
A: Running a Docker daemon inside Docker is complex, slow, and requires `--privileged` mode. Socket mounting is simpler and industry standard.

**Q: What about security?**
A: Mounting Docker socket = root access to host. For dev/single-user this is fine (same as `sudo`). For production, add restrictions (out of scope for "simple" design).

**Q: Do ports conflict between worktrees?**
A: No! Template system ensures unique ports: `{{add 3000 worktree.unique_id}}` → 3001, 3002, etc.

**Q: Can worktree containers talk to Agor daemon?**
A: Yes! Use `host.docker.internal:3030` (works on all platforms) or join Agor's Docker network.

**Q: What about Windows/Mac Docker Desktop?**
A: Socket mounting works identically. Path handling may differ (WSL2 paths on Windows).

**Q: How do we handle docker-compose.yml in worktrees?**
A: Worktrees contain their own repos with their own docker-compose.yml. Agor just runs `docker compose up` in that directory.

**Q: Do we need to modify existing `.agor.yml` files?**
A: No! Existing configs already use `docker compose` commands. They'll just work once Docker CLI is available.

---

## Summary

**What we're doing:**
1. Install Docker CLI in Agor container (Dockerfile)
2. Mount Docker socket (docker-compose.yml)
3. Fix permissions at runtime (entrypoint script)

**What we're NOT doing:**
- Running Docker daemon inside container
- Advanced security hardening
- Network complexity management
- Resource quotas/limits

**Why this works:**
- Industry-standard pattern (CI/CD systems use this)
- Leverages existing template system (no code changes)
- Simple, minimal, gets the job done

**Result:** Worktrees can run `docker compose up`, each with unique ports, isolated environments, all managed by Agor's existing environment config system.

---

**Next Steps:** Review this design → Implement changes → Test → Document → Ship! 🚀

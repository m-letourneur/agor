# Quick Reference: Docker-in-Docker for Agor

**TL;DR:** Mount Docker socket + Install Docker CLI = Worktrees can run Docker Compose

---

## Visual Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Host Machine (Docker Daemon Running)                    │
│                                                          │
│  /var/run/docker.sock (Docker API socket)              │
│    │                                                     │
│    │ mounted into ↓                                     │
│    │                                                     │
│  ┌─┴─────────────────────────────────────────────────┐ │
│  │ Agor Container (agor-dev)                         │ │
│  │                                                    │ │
│  │  • Docker CLI installed ✓                         │ │
│  │  • Docker socket at /var/run/docker.sock ✓        │ │
│  │  • 'agor' user in docker group ✓                  │ │
│  │                                                    │ │
│  │  Runs: docker compose -p agor-feature-x up -d     │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  Result: Creates SIBLING containers ↓                   │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Worktree Environment Containers (siblings)         │ │
│  │                                                     │ │
│  │  • agor-feature-x-app-1    (DAEMON_PORT=3001)     │ │
│  │  • agor-feature-y-app-1    (DAEMON_PORT=3002)     │ │
│  │  • agor-bugfix-z-app-1     (DAEMON_PORT=3003)     │ │
│  │                                                     │ │
│  │  All share host filesystem (bind mounts work!)     │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## Three Changes Required

### 1. Dockerfile (Install Docker CLI)

**Location:** `docker/Dockerfile` in base stage

```dockerfile
# Install Docker CLI dependencies
RUN apt-get update && apt-get install -y \
  ca-certificates \
  gnupg \
  lsb-release \
  && rm -rf /var/lib/apt/lists/*

# Install Docker CLI + Compose plugin
RUN install -m 0755 -d /etc/apt/keyrings && \
  curl -fsSL https://download.docker.com/linux/debian/gpg | \
    gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
  chmod a+r /etc/apt/keyrings/docker.gpg && \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list && \
  apt-get update && \
  apt-get install -y docker-ce-cli docker-compose-plugin && \
  rm -rf /var/lib/apt/lists/*
```

### 2. docker-compose.yml (Mount Socket)

**Location:** `docker-compose.yml` in agor-dev service volumes

```yaml
services:
  agor-dev:
    volumes:
      # ... existing volumes ...
      - /var/run/docker.sock:/var/run/docker.sock  # ADD THIS LINE
```

### 3. Entrypoint Script (Fix Permissions)

**Location:** `docker/docker-entrypoint.sh` at beginning

```bash
# Docker socket access setup
if [ -S /var/run/docker.sock ]; then
  echo "[entrypoint] Configuring Docker socket access..."
  DOCKER_SOCK_GID=$(stat -c '%g' /var/run/docker.sock)

  if ! getent group ${DOCKER_SOCK_GID} > /dev/null 2>&1; then
    sudo groupadd -g ${DOCKER_SOCK_GID} docker
  fi

  sudo usermod -aG ${DOCKER_SOCK_GID} agor
  echo "[entrypoint] ✓ Docker access configured"
fi
```

---

## Testing Commands

```bash
# 1. Rebuild and start
docker compose build
docker compose up -d

# 2. Verify Docker access inside container
docker compose exec agor-dev docker ps
# Should show: agor-dev container itself + any others

# 3. Create test worktree
docker compose exec agor-dev bash
cd /home/agor/.agor/worktrees/agor/my-test
echo 'services:
  test:
    image: nginx:alpine
    ports:
      - "8080:80"
' > docker-compose.yml

# 4. Test docker compose from inside Agor container
docker compose -p test-worktree up -d

# 5. Verify sibling container
docker ps | grep test-worktree
# Should see: test-worktree-test-1 running

# 6. Cleanup
docker compose -p test-worktree down
```

---

## How Port Allocation Works

```yaml
# .agor.yml template
environment:
  start: DAEMON_PORT={{add 3000 worktree.unique_id}} UI_PORT={{add 5000 worktree.unique_id}} docker compose up -d
```

**Renders to:**

| Worktree      | unique_id | DAEMON_PORT | UI_PORT |
|---------------|-----------|-------------|---------|
| main          | 1         | 3001        | 5001    |
| feature-auth  | 2         | 3002        | 5002    |
| bugfix-cors   | 3         | 3003        | 5003    |

**In worktree's docker-compose.yml:**

```yaml
services:
  app:
    ports:
      - "${DAEMON_PORT}:3030"  # Env var set by Agor template
      - "${UI_PORT}:5173"
```

**Result:** Each worktree gets unique external ports, no conflicts! 🎉

---

## Common Patterns

### Pattern 1: Basic Docker Compose App

```yaml
# .agor.yml (in repo root)
environment:
  start: docker compose -p {{worktree.name}} up -d
  stop: docker compose -p {{worktree.name}} down
  logs: docker compose -p {{worktree.name}} logs --tail=100
  health: http://localhost:3000
  app: http://localhost:3000
```

### Pattern 2: Multi-Port App (Agor's own config)

```yaml
# .agor.yml (in repo root)
environment:
  start: DAEMON_PORT={{add 3000 worktree.unique_id}} UI_PORT={{add 5000 worktree.unique_id}} docker compose -p agor-{{worktree.name}} up -d
  stop: docker compose -p agor-{{worktree.name}} down
  nuke: docker compose -p agor-{{worktree.name}} down -v
  health: http://localhost:{{add 3000 worktree.unique_id}}/health
  app: http://localhost:{{add 5000 worktree.unique_id}}
  logs: docker compose -p agor-{{worktree.name}} logs --tail=100
```

### Pattern 3: Custom Environment Variables

```yaml
# .agor.yml (in repo root)
environment:
  start: |
    export APP_PORT={{add 8000 worktree.unique_id}}
    export DB_NAME={{worktree.name}}
    export WORKTREE_PATH={{worktree.path}}
    docker compose -p {{worktree.name}} up -d
  stop: docker compose -p {{worktree.name}} down
```

---

## Troubleshooting

### "docker: command not found"

**Cause:** Docker CLI not installed
**Fix:** Rebuild image with updated Dockerfile

```bash
docker compose build --no-cache
docker compose up -d
```

### "permission denied while trying to connect to Docker daemon"

**Cause:** User not in docker group
**Fix:** Check entrypoint script ran correctly

```bash
docker compose exec agor-dev bash
groups  # Should show: agor docker
docker ps  # Should work
```

### "Cannot connect to Docker daemon at unix:///var/run/docker.sock"

**Cause:** Socket not mounted
**Fix:** Check docker-compose.yml has volume mount

```bash
docker compose exec agor-dev ls -la /var/run/docker.sock
# Should show: srw-rw---- 1 root docker
```

### Worktree containers can't reach Agor daemon

**Cause:** Network isolation (different Docker networks)
**Fix:** Use `host.docker.internal` hostname

```yaml
# In worktree's docker-compose.yml
environment:
  - AGOR_DAEMON_URL=http://host.docker.internal:3030
```

### Bind mounts fail in worktree containers

**Cause:** Using host paths instead of container paths
**Fix:** Use relative paths or container absolute paths

```yaml
# ✓ Good (relative)
volumes:
  - .:/app

# ✓ Good (container absolute path)
volumes:
  - /home/agor/.agor/worktrees/myrepo/feat-x:/app

# ✗ Bad (host user path)
volumes:
  - ~/code/myrepo:/app  # This is host's home, not accessible!
```

---

## Security Note

⚠️ **Warning:** Mounting `/var/run/docker.sock` gives the Agor container full access to the Docker daemon. This means:

- Can start/stop any container
- Can access host filesystem via bind mounts
- Equivalent to root access on host

**Acceptable for:**
- Development environments
- Single-user setups
- Trusted teams

**NOT recommended for:**
- Multi-tenant production (without additional security layers)
- Untrusted users
- Public-facing services

**Future hardening options:**
- Docker socket proxy (restrict commands)
- Rootless Docker
- SELinux/AppArmor policies
- Container runtime security tools

---

## FAQ

**Q: Do I need to change existing `.agor.yml` files?**
A: No! They already use `docker compose` commands. Once Docker is available, they'll just work.

**Q: Can multiple worktrees run simultaneously?**
A: Yes! Each uses unique ports via template system.

**Q: What about database data?**
A: Use Docker volumes in worktree's docker-compose.yml:
```yaml
volumes:
  postgres-data:  # Named volume (persists)
```

**Q: Can I use Kubernetes instead?**
A: Not in this simple design. Future enhancement.

**Q: Do I need to restart Agor after changes?**
A: Yes, rebuild image: `docker compose build && docker compose up -d`

---

**Questions?** Check the full design doc: `DESIGN-SIMPLE-DIND.md`

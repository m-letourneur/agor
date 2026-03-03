# Docker-in-Docker Design for Agor Worktrees

**Status:** Design Complete ✅
**Date:** 2026-03-03
**Branch:** `design-simple-dind`

---

## Overview

This directory contains the complete design and implementation plan for enabling Agor worktrees to run their own Docker Compose environments while Agor itself runs in Docker.

**The Simple Approach:** Mount Docker socket + Install Docker CLI = Worktrees can `docker compose up` 🎉

---

## Documents

### 1. [DESIGN-SIMPLE-DIND.md](./DESIGN-SIMPLE-DIND.md)
**Read this first!**

Complete design document covering:
- Current state analysis
- Architecture explanation (Docker socket mounting)
- Why this is the simplest approach
- Testing strategy
- Known limitations
- Future enhancements

**Key insight:** Agor's `.agor.yml` already uses `docker compose` commands—we just need to make Docker available!

### 2. [DIND-QUICK-REFERENCE.md](./DIND-QUICK-REFERENCE.md)
**TL;DR version**

Quick reference guide with:
- Visual architecture diagram
- 3 changes needed (Dockerfile, docker-compose.yml, entrypoint)
- Testing commands
- Port allocation examples
- Common patterns
- Troubleshooting

**Perfect for:** Implementation, copy-paste, quick lookups

### 3. [IMPLEMENTATION-DIFF.md](./IMPLEMENTATION-DIFF.md)
**Concrete code changes**

Exact diffs for implementation:
- Before/after code blocks
- Line numbers and locations
- Explanations for each change
- Testing verification script
- Build/deploy commands
- Rollback plan

**Perfect for:** Actually implementing the changes

### 4. [SECURITY-AND-BEST-PRACTICES.md](./SECURITY-AND-BEST-PRACTICES.md)
**Security considerations**

Comprehensive security analysis:
- Threat model
- Appropriate use cases (✅ dev, ❌ multi-tenant)
- Best practices for users/admins
- Security hardening options (future)
- Compliance considerations
- Incident response

**Perfect for:** Understanding risks, making deployment decisions

---

## Implementation Status

✅ **IMPLEMENTED** - All code changes have been applied to this branch.

### Changes Made

The following files have been modified to enable Docker-in-Docker support:

1. **`docker/Dockerfile`** - Added Docker CLI and Compose plugin installation
   - Installs `ca-certificates`, `gnupg`, `lsb-release` dependencies
   - Adds Docker official APT repository
   - Installs `docker-ce-cli` and `docker-compose-plugin`
   - Verifies installation during build

2. **`docker-compose.yml`** - Mounted Docker socket
   - Adds volume mount: `/var/run/docker.sock:/var/run/docker.sock`
   - Enables Agor container to communicate with host Docker daemon

3. **`docker/docker-entrypoint.sh`** - Configured socket permissions
   - Detects mounted Docker socket at startup
   - Creates docker group matching socket GID
   - Adds `agor` user to docker group
   - Verifies access with test command
   - Provides helpful error messages

4. **`docker/test-dind.sh`** - Created verification script (NEW)
   - Tests Docker CLI availability
   - Verifies daemon connectivity
   - Validates user permissions
   - Runs test container

### How to Deploy

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
# Should see: "✓ Docker socket access verified"
```

### Rollback Instructions

If you need to revert these changes:

```bash
# Stop containers
docker compose down

# Revert code changes
git checkout HEAD~1 -- docker/Dockerfile docker-compose.yml docker/docker-entrypoint.sh
git clean -f docker/test-dind.sh

# Rebuild original image
docker compose build

# Restart
docker compose up -d
```

---

## Quick Summary

### What We're Doing

1. Install Docker CLI in Agor container
2. Mount Docker socket from host
3. Fix permissions at startup

~60 lines of code total.

### What We're Getting

✅ Worktrees can run docker compose
✅ Unique ports per worktree (template system)
✅ Full environment isolation
✅ Existing configs work without changes

### Architecture

```
Host Docker Daemon
  ├── Agor Container (has Docker CLI + socket access)
  ├── Worktree 1 Environment (sibling, ports 3001/5001)
  ├── Worktree 2 Environment (sibling, ports 3002/5002)
  └── Worktree 3 Environment (sibling, ports 3003/5003)
```

**Key:** Not nested Docker, but sibling containers!

---

## Quick Start

**To understand the design:**
→ Read DESIGN-SIMPLE-DIND.md

**To implement:**
→ Follow IMPLEMENTATION-DIFF.md

**For quick reference:**
→ Check DIND-QUICK-REFERENCE.md

**For security review:**
→ Review SECURITY-AND-BEST-PRACTICES.md

---

## Next Steps

1. Review design documents
2. Assess security for your use case
3. Implement changes (3 files, ~1 hour)
4. Test thoroughly (~1 hour)
5. Deploy with confidence!

🚀 **Let's ship it!**

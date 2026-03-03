# Security & Best Practices: Docker-in-Docker

**Context:** Agor worktrees running Docker Compose via mounted Docker socket

---

## Security Model

### Current Setup: Shared Docker Socket

```
┌─────────────────────────────────────────┐
│ Host Docker Daemon (root privileges)    │
│                                          │
│  /var/run/docker.sock                   │
│    ↓                                     │
│  Agor Container (agor user)             │
│  • Can start ANY container              │
│  • Can mount ANY host path              │
│  • Can access host network              │
│  • Effectively root-equivalent          │
└─────────────────────────────────────────┘
```

**What this means:**
- Docker socket access = root access to host
- Agor container can do anything Docker can do
- Malicious code in Agor could compromise host
- Worktree environments inherit this power

---

## Threat Model

### Threats We're Accepting (Dev/Single-User)

1. **Malicious Worktree Environment**
   - **Scenario:** User creates worktree, adds malicious docker-compose.yml
   - **Impact:** Could mount host filesystem, exfiltrate data, crypto mining
   - **Mitigation:** Trust relationship—user created the worktree
   - **Acceptable because:** Same as user running `docker compose up` on host

2. **Compromised Dependencies**
   - **Scenario:** npm package or Docker image contains malware
   - **Impact:** Could escape container, access host Docker
   - **Mitigation:** Standard supply chain security (audit dependencies)
   - **Acceptable because:** Same risk as any dev environment

3. **Privilege Escalation**
   - **Scenario:** Bug in Agor daemon exploited to run arbitrary commands
   - **Impact:** Attacker gains Docker access = root
   - **Mitigation:** Code review, security updates
   - **Acceptable because:** Dev environment, trusted network

### Threats We're NOT Addressing (Yet)

1. **Multi-Tenant Isolation**
   - **Scenario:** Multiple untrusted users sharing Agor instance
   - **Current state:** ❌ NOT SAFE
   - **Why:** Any user can start containers, access all Docker resources
   - **Future solution:** Docker socket proxy, namespace isolation

2. **Resource Exhaustion**
   - **Scenario:** Worktree environment uses all CPU/RAM/disk
   - **Current state:** ❌ NO LIMITS
   - **Why:** Docker containers have no resource constraints
   - **Future solution:** Docker resource limits (--cpus, --memory)

3. **Network Segmentation**
   - **Scenario:** Worktree container attacks other containers
   - **Current state:** ❌ SHARED NETWORK
   - **Why:** All containers on same Docker network by default
   - **Future solution:** Isolated networks per worktree

---

## Appropriate Use Cases

### ✅ Safe to Use

**Single-User Development**
- Developer's personal machine
- Trusted local environment
- Same security model as running Docker directly

**Trusted Team Development**
- Small team of trusted developers
- Shared dev server (not production)
- All users have equivalent access anyway

**Educational/Demo Environments**
- Learning Docker/Agor
- Conference demos
- Sandboxed VMs (throwaway environments)

**Personal Cloud Server**
- Single user's VPS
- Private network
- No untrusted users

### ❌ NOT Safe Yet

**Multi-Tenant SaaS**
- Public Agor instance
- Untrusted users
- Shared infrastructure
- **Risk:** Any user can compromise entire system

**Production Workloads**
- Customer-facing services
- Mission-critical apps
- Compliance requirements (SOC2, HIPAA, etc.)
- **Risk:** Container breakout = full compromise

**Public/Open Registration**
- Public signup without vetting
- Anonymous users
- Untrusted code execution
- **Risk:** Immediate exploitation

---

## Best Practices

### For Developers Using Agor

1. **Trust Your Worktrees**
   - Only create worktrees for trusted repos
   - Review docker-compose.yml before starting environment
   - Don't clone random repos and start them

2. **Use Named Docker Volumes**
   ```yaml
   # ✓ Good: Named volume (isolated)
   volumes:
     postgres-data:

   services:
     db:
       volumes:
         - postgres-data:/var/lib/postgresql/data

   # ✗ Bad: Bind mount to host (can access anything)
   services:
     db:
       volumes:
         - /home/user/.secrets:/secrets
   ```

3. **Limit Port Exposure**
   ```yaml
   # ✓ Good: Localhost only
   ports:
     - "127.0.0.1:5173:5173"

   # ⚠ Caution: Exposed to network
   ports:
     - "5173:5173"  # Accessible from any IP!
   ```

4. **Use Official Images**
   ```yaml
   # ✓ Good: Official, verified images
   services:
     app:
       image: node:20-alpine

   # ⚠ Caution: Random Docker Hub image
   services:
     app:
       image: randomuser/sketchy-nodejs
   ```

5. **Review Generated Commands**
   - Check what Agor will run (UI shows rendered template)
   - Verify environment variables are correct
   - Test with `docker compose config` first

### For Agor Administrators

1. **Network Segmentation**
   - Run Agor on isolated network
   - Firewall rules for external access
   - VPN for remote developers

2. **Backup Strategy**
   - Regular backups of `~/.agor/` directory
   - Docker volume backups
   - Git repos backed up externally

3. **Monitoring**
   ```bash
   # Watch for suspicious containers
   docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}"

   # Check resource usage
   docker stats

   # Review logs regularly
   docker compose logs | grep -i error
   ```

4. **Cleanup Old Containers**
   ```bash
   # List stopped containers
   docker ps -a --filter "status=exited"

   # Remove stopped worktree containers
   docker ps -a --filter "name=agor-" --filter "status=exited" -q | xargs docker rm

   # Clean up unused volumes (CAREFUL!)
   docker volume prune
   ```

5. **Update Regularly**
   - Keep Docker updated
   - Keep Agor updated
   - Rebuild images after security patches

---

## Security Hardening (Future)

### Level 1: Docker Socket Proxy

**Instead of mounting raw socket, use a filtering proxy:**

```yaml
# Add to docker-compose.yml
services:
  docker-proxy:
    image: tecnativa/docker-socket-proxy
    environment:
      # Only allow safe commands
      CONTAINERS: 1
      POST: 1
      BUILD: 1
      COMMIT: 1
      EXEC: 0  # Disable exec (can't access running containers)
      IMAGES: 1
      NETWORKS: 1
      VOLUMES: 1
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro

  agor-dev:
    environment:
      - DOCKER_HOST=tcp://docker-proxy:2375
    # Remove docker.sock mount
```

**Benefits:**
- Restricts available Docker commands
- Blocks privileged operations
- Auditable (logs all commands)

**Downsides:**
- More complex setup
- Some operations may not work
- Additional container overhead

### Level 2: Rootless Docker

**Run Docker daemon as non-root user:**

```bash
# Host setup (outside Agor)
curl -fsSL https://get.docker.com/rootless | sh
export DOCKER_HOST=unix:///run/user/1000/docker.sock

# Mount rootless socket instead
# In docker-compose.yml:
volumes:
  - /run/user/1000/docker.sock:/var/run/docker.sock
```

**Benefits:**
- Docker daemon runs without root
- Limited host access
- Better namespace isolation

**Downsides:**
- Complex setup
- Some features don't work (privileged containers)
- Performance overhead

### Level 3: Kubernetes/Podman

**Replace Docker entirely:**

```yaml
# Use Kubernetes Jobs for worktree environments
# Or use Podman (daemonless, rootless by default)
```

**Benefits:**
- Better multi-tenancy
- Resource limits built-in
- Production-ready orchestration

**Downsides:**
- Much more complex
- Learning curve
- Operational overhead

---

## Security Checklist

### Before Deploying

- [ ] Understand threat model (see above)
- [ ] Confirm appropriate use case (single-user or trusted team)
- [ ] Review who has access to Agor
- [ ] Set up network firewall rules
- [ ] Configure backup strategy
- [ ] Plan monitoring/alerting
- [ ] Document security decisions

### Regular Maintenance

- [ ] Weekly: Review running containers (`docker ps`)
- [ ] Weekly: Check disk usage (`docker system df`)
- [ ] Monthly: Clean up stopped containers
- [ ] Monthly: Update Docker + Agor
- [ ] Quarterly: Review security practices
- [ ] Quarterly: Audit worktree docker-compose.yml files

### Incident Response

**If you suspect compromise:**

1. **Immediate:**
   ```bash
   # Stop all containers
   docker stop $(docker ps -q)

   # Stop Agor
   docker compose down
   ```

2. **Investigate:**
   ```bash
   # Check what containers ran
   docker ps -a --format "table {{.Names}}\t{{.Image}}\t{{.CreatedAt}}"

   # Review logs
   docker logs <suspicious-container>

   # Check for privilege escalation
   docker inspect <suspicious-container> | grep -i privileged
   ```

3. **Remediate:**
   - Change all credentials
   - Review git commits for malicious code
   - Rebuild Agor image from scratch
   - Restore from clean backup if needed

4. **Prevent:**
   - Add monitoring/alerting
   - Review access controls
   - Consider hardening measures (socket proxy, etc.)

---

## Compliance Considerations

### Data Protection

**GDPR/Privacy:**
- Docker logs may contain sensitive data
- Worktree environments may process PII
- Configure log rotation and retention

**Recommendations:**
```yaml
# docker-compose.yml
services:
  agor-dev:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

### Audit Trail

**SOC2/ISO27001:**
- Track who created which worktrees
- Log environment start/stop commands
- Retain Docker event logs

**Recommendations:**
```bash
# Enable Docker audit logging
docker events --format '{{json .}}' >> /var/log/docker-events.log

# Review periodically
jq 'select(.Type=="container" and .Action=="start")' /var/log/docker-events.log
```

### Access Control

**Industry Standards:**
- Principle of least privilege
- Role-based access control
- Audit user actions

**Current State:**
- ❌ No fine-grained RBAC yet
- ✅ Unix-level user isolation (Agor feature)
- ✅ Session attribution (who ran what)

---

## Comparison to Alternatives

### This Approach (Docker Socket)

**Pros:**
- ✅ Simple setup (3 file changes)
- ✅ Industry standard pattern
- ✅ Works everywhere Docker runs
- ✅ Good performance

**Cons:**
- ❌ Root-equivalent access
- ❌ No multi-tenant isolation
- ❌ No resource limits
- ❌ Shared network namespace

### Alternative: Sysbox (Rootless Containers)

**Pros:**
- ✅ Better isolation
- ✅ Nested containers without privileges
- ✅ User namespace separation

**Cons:**
- ❌ Complex setup
- ❌ Not widely available
- ❌ Performance overhead
- ❌ Limited Docker feature support

### Alternative: Kubernetes

**Pros:**
- ✅ Production-ready
- ✅ Resource limits built-in
- ✅ Multi-tenant by design
- ✅ Battle-tested at scale

**Cons:**
- ❌ Very complex
- ❌ Requires K8s cluster
- ❌ Steep learning curve
- ❌ Overkill for dev environments

**Decision:** Docker socket approach is best for **phase 1** (dev/small teams). Can upgrade to alternatives later if needed.

---

## Documentation Requirements

### User-Facing Docs

**Installation Guide:**
```markdown
## Security Note

Agor uses Docker-in-Docker to run worktree environments. This requires
mounting the Docker socket (`/var/run/docker.sock`), which gives Agor
full access to the Docker daemon.

**What this means:**
- Agor can start/stop any Docker container
- Worktree environments have access to Docker
- Equivalent to having sudo/root access

**Safe for:** Personal dev environments, trusted teams
**Not safe for:** Public instances, untrusted users

If you're unsure whether this is appropriate for your use case, please
review the security documentation: SECURITY-AND-BEST-PRACTICES.md
```

**Worktree Environment Guide:**
```markdown
## Creating Worktree Environments

Your docker-compose.yml runs with Docker socket access. Follow these
guidelines for safety:

✅ DO:
- Use official Docker images
- Bind mount only your worktree directory
- Use localhost-only port bindings
- Review configuration before starting

❌ DON'T:
- Mount sensitive host directories (/etc, /home, etc.)
- Run privileged containers (unless you know why)
- Use untrusted Docker images
- Expose services to public internet without authentication

See examples: docs/worktree-environments.md
```

### Admin Documentation

**Setup Guide:**
- Prerequisites (Docker version)
- Installation steps
- Security checklist
- Monitoring recommendations
- Backup strategy

**Troubleshooting:**
- Permission denied errors
- Container conflicts
- Network issues
- Resource exhaustion

---

## Summary

### Current Security Posture

| Aspect | Status | Notes |
|--------|--------|-------|
| Container isolation | ❌ Weak | Shared Docker socket |
| Resource limits | ❌ None | No CPU/RAM constraints |
| Network isolation | ❌ None | Shared Docker network |
| Multi-tenancy | ❌ Not safe | Any user = full access |
| Audit logging | ⚠️ Basic | Docker logs only |
| Privilege separation | ⚠️ Limited | Via Unix user mode |

### Acceptable Use

- ✅ Personal dev environment
- ✅ Trusted team dev server
- ✅ Sandboxed/VM environments
- ❌ Public/multi-tenant SaaS
- ❌ Production workloads
- ❌ Compliance-critical systems

### Future Roadmap

**Phase 1 (Current):** Simple Docker socket—good enough for dev

**Phase 2 (Next):** Docker socket proxy—adds safety layer

**Phase 3 (Future):** Rootless Docker—better isolation

**Phase 4 (Long-term):** Kubernetes—production-ready orchestration

---

**Remember:** Perfect is the enemy of good. This simple approach unblocks worktree environments NOW. We can iterate on security as usage grows. 🚀

**Questions?** Review full context:
- Design: `DESIGN-SIMPLE-DIND.md`
- Implementation: `IMPLEMENTATION-DIFF.md`
- Quick ref: `DIND-QUICK-REFERENCE.md`
- Security: This file

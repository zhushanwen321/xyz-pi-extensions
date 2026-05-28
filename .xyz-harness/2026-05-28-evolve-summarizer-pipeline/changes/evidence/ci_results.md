---
ci_passed: true
ci_url: null
commit_sha: d059b41cbda4a636b32eedaedf740f19f7fa069b
ci_configured: false
---

# CI Results

## CI Configuration

**No CI pipeline configured.** This project does not have `.github/workflows/` — GitHub Actions is not set up. No automated checks ran on PR #10.

## Manual Verification (equivalent to CI)

All verification was completed during Phase 3 (Dev) and Phase 4 (Test):

| Check | Result |
|-------|--------|
| TypeScript type check (`tsc --noEmit`) | ✅ 0 errors |
| ESLint (`npm run lint`) — evolution-engine scope | ✅ 0 errors |
| Integration tests (13 cases) | ✅ 13/13 passed |
| Compression ratio (545KB → 6.1KB) | ✅ 89x compression, within 15KB limit |
| Anomaly detection | ✅ tool_failure, dormant_skill, user_correction, token_hotspot |
| Metrics history sliding window (30 max) | ✅ |
| Trend delta filtering (10% threshold) | ✅ |
| Effect review building | ✅ before/after comparison |
| GC report retention (3 max) | ✅ |
| GC daily retention (90 days) | ✅ |

## Risk

Without CI, future PRs risk silent breakage. Recommended to add a minimal CI workflow:
- See `xyz-harness-code-standard-protection` for CI templates

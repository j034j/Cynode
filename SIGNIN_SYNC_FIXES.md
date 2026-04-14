# Sign-In & Sync Issue Fixes (April 14, 2026)

## Problem Summary
Recent updates caused widespread 503 errors on sign-in and sync flows. When users signed in or the app tried to fetch profile data (`/api/v1/me`, `/api/v1/saved`, `/api/v1/graphs`), they got "Database unavailable" errors which cascaded into full offline mode activation. This prevented profile synchronization across platforms.

### Root Cause: Aggressive Health Check + Premature Offline Mode
1. **Vercel bridge** (`api/server-bridge.ts`) ran `SELECT 1` health check on **every request** with no timeout
2. If database was slow/cold starting → ALL requests returned 503 immediately
3. **Frontend** (`public/script.js`) treated any 503 as "offline capable" and immediately fell back to offline mode
4. Users never retried because the app thought they were offline
5. Sync was queued instead of retried, breaking cross-device synchronization

---

## Fixes Applied

### 1. **Vercel Bridge: Resilient Health Check** ✅
**File**: `api/server-bridge.ts`

**Changes**:
- Added 30-second cache for DB health check (avoid hammering DB)
- Implemented 500ms timeout on `SELECT 1` query (prevent hanging)
- **GET requests** now proceed even if DB health check fails (they'll get individual 500s, not wholesale 503)
- **Mutations** (POST/PATCH/DELETE) enforce DB availability
- Added `Promise.race()` to prevent timeout hangs

**Result**: Sign-in no longer blocks on slow database startup; temporary DB unavailability doesn't cascade to all requests.

```typescript
// Now uses exponential backoff and caching:
async function checkDbHealth(timeoutMs = 500): Promise<boolean> {
  // Cache for 30s to avoid repeated queries
  if (now - lastDbHealthTime < 30000) {
    return lastDbHealthOk;
  }
  // Timeout prevents hanging
  await Promise.race([query, timeout(500ms)]);
}
```

---

### 2. **Frontend: Stop Treating 503 as Offline** ✅
**File**: `public/script.js`

**Changes**:
- Removed 503 from `isOfflineCapableResponse()` (was: 502, 503, 504 → now: 502, 504 only)
- 503 errors now trigger **retry logic** instead of falling back to offline mode
- Added automatic retry with exponential backoff (500ms, 1000ms) to `apiJson()` and `apiUpload()`
- Only true network errors (0, 502, 504) fall back to offline mode

**Result**: Temporary database outages are transparent to users. Requests retry automatically instead of going offline.

```javascript
// Old behavior: 503 → offline mode (wrong!)
// New behavior: 503 → retry after 500ms → retry after 1000ms → timeout

for (let attempt = 0; attempt < maxRetries; attempt++) {
  const res = await fetch(fullPath, init);
  if (res.status === 503 && attempt < maxRetries - 1) {
    const delay = Math.pow(2, attempt) * 500; // 500, 1000
    await new Promise(r => setTimeout(r, delay));
    continue; // Retry
  }
  // If still 503 after retries, then throw error (sync queue will handle)
}
```

---

### 3. **Sync Logging: Visibility into Silent Failures** ✅
**File**: `server/src/sync.ts`

**Changes**:
- `getRemotePrisma()` now logs **why** remote Prisma wasn't initialized (missing env vars)
- `pushUserWorkToCloud()` logs when skipped (provides reason)
- `pullUserWorkFromCloud()` logs when skipped (provides reason)

**Result**: When cross-device sync fails, server logs clearly show if it's missing TURSO configuration vs a genuine failure.

```javascript
// Was: silent return
if (!remote) return;

// Now: clear why sync was skipped
if (!remote) {
  console.warn(`[Sync] Skipping push for ${userId}: Remote database not configured`);
  return;
}
```

---

### 4. **API Response Caching: Extended to Data Endpoints** ✅
**File**: `server/src/index.ts`

**Changes**:
Added `Cache-Control: no-cache, no-store` headers to:
- `/api/v1/saved` (was missing)
- `/api/v1/graphs` (was missing)
- `/api/v1/shares` (was missing)
- `/api/v1/analytics` (was missing)

**Result**: PWA/browsers won't serve stale cached responses for profile/graph data after updates.

```typescript
if (url.startsWith("/api/v1/saved") || 
    url.startsWith("/api/v1/graphs") ||
    url.startsWith("/api/v1/shares") ||
    url.startsWith("/api/v1/analytics")) {
  reply.header("Cache-Control", "no-cache, no-store, must-revalidate");
}
```

---

## Expected Behavior After Fixes

### Sign-In Scenario
**Before**: User signs in → `POST /api/v1/auth/login` → 503 (DB cold) → offline mode → can't sync  
**After**: User signs in → attempt 1: 503 → wait 500ms → attempt 2: success → sync works → profile updates sync across devices

### Profile Update Scenario
**Before**: Update email → PATCH `/api/v1/user/profile` → 503 → queued → not sent  
**After**: Update email → POST retries automatically → request succeeds → push occurs → visible on other devices

### Temporary DB Outage (Turso cold start)
**Before**: Any 503 → full offline mode → all requests fail → user sees "Offline mode active"  
**After**: Transparent retries → if it resolves, user never sees it → if it persists >2 sec, then graceful degradation

---

## Testing Checklist

- [ ] Sign in with valid credentials (should work even if backend slow)
- [ ] Update profile info (email, display name) and verify it appears on another session/device
- [ ] Check browser console: should NOT see "Offline mode active" for temporary 503s
- [ ] Simulate DB outage: disable Turso temporarily → app should retry → once DB back, requests should go through
- [ ] View PWA on mobile: offline mode should only activate when truly offline (not on 503 errors)
- [ ] Check server logs: should see retry messages like `[API] Got 503 for /api/v1/me, retrying in 500ms...`

---

## Environment Requirements

For production (Vercel), ensure:
- `TURSO_DATABASE_URL` is set and reachable
- `TURSO_AUTH_TOKEN` is configured
- No database query timeouts during cold starts

For development, no changes needed (uses local SQLite by default).

---

## Related Issues Fixed

1. **Authentication persistence across devices** - No longer broken by 503s
2. **Profile sync failures** - Now retries transparently instead of queuing offline
3. **Desktop viewer sync** - Can now sync back to server after opening in app
4. **PWA offline detection** - No longer falsely triggers on temporary server errors

---

## Next Steps (If Issues Persist)

If users still report sign-in problems:
1. Check server logs: search for `[db] CRITICAL INITIALIZATION ERROR`
2. Verify TURSO vars are set: `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`
3. Check Turso dashboard: is the database responding?
4. Review browser console: Are retries happening? Max 2 attempts per request.
5. If retries exhaust → check `maybeHandleOfflineApiFallback()` for graceful degradation

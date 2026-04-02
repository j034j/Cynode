/**
 * Cynode Account Management
 */

const CACHED_ME_KEY = 'cynodeCachedMe:v1';

function readCachedMe() {
    try {
        const raw = localStorage.getItem(CACHED_ME_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (_) {
        return null;
    }
}

function writeCachedMe(value) {
    try {
        localStorage.setItem(CACHED_ME_KEY, JSON.stringify(value));
    } catch (_) {}
}

function setStatus(element, variant, message) {
    if (!element) return;
    element.className = variant ? `status-msg ${variant}` : 'status-msg';
    element.textContent = message || '';
}

function setAvatarPreview(url) {
    const img = document.getElementById('avatarPreview');
    const fallback = document.getElementById('avatarFallback');
    if (!img || !fallback) return;

    if (!url) {
        img.removeAttribute('src');
        img.style.display = 'none';
        fallback.style.display = '';
        return;
    }

    img.src = url;
    img.style.display = '';
    fallback.style.display = 'none';
    img.onerror = () => {
        img.removeAttribute('src');
        img.style.display = 'none';
        fallback.style.display = '';
    };
}

function renderMemberships(me) {
    const container = document.getElementById('orgMemberships');
    if (!container) return;

    const orgs = me && Array.isArray(me.organizations) ? me.organizations : [];
    if (!orgs.length) {
        container.innerHTML = '<div class="info-value muted">No organization memberships yet.</div>';
        return;
    }

    container.innerHTML = '';
    orgs.forEach((org) => {
        const pill = document.createElement('div');
        const title = document.createElement('strong');
        const meta = document.createElement('span');

        pill.className = 'list-pill';
        title.textContent = org.name || org.slug || 'Organization';
        meta.textContent = `${org.role} / ${org.planKey} (${org.planStatus})`;

        pill.appendChild(title);
        pill.appendChild(meta);
        container.appendChild(pill);
    });
}

function renderProfile(me) {
    const user = me && me.user ? me.user : null;
    if (!user) return;

    const isOffline = !!me.offline;
    const displayName = user.displayName || user.handle || 'Cynode user';
    const email = user.email || (isOffline ? 'Offline profile cached on this device' : 'No email on file');
    const plan = me && me.userPlan ? `${me.userPlan.planKey} (${me.userPlan.status})` : (isOffline ? 'Unavailable offline' : 'Free');

    document.getElementById('heroName').textContent = displayName;
    document.getElementById('heroHandle').textContent = user.handle ? `@${user.handle}` : 'Signed in';
    document.getElementById('heroEmail').textContent = email;
    document.getElementById('heroStatus').textContent = isOffline
        ? 'Offline read-only profile view'
        : 'Live account session connected';

    document.getElementById('viewHandle').textContent = user.handle ? `@${user.handle}` : '---';
    document.getElementById('viewId').textContent = user.id || '---';
    document.getElementById('viewPlan').textContent = plan;
    document.getElementById('viewSync').textContent = isOffline
        ? 'Using cached profile data until Cynode reconnects.'
        : 'Profile changes sync through the shared Cynode backend.';
    document.getElementById('viewSession').textContent = isOffline ? 'Offline cached session' : 'Signed in';
    document.getElementById('viewSource').textContent = isOffline ? 'Local cache fallback' : 'Live backend response';

    const orgs = me && Array.isArray(me.organizations) ? me.organizations : [];
    const orgSummary = orgs.length
        ? orgs.map((org) => `${org.slug} (${org.role})`).join(' | ')
        : 'No organization memberships';

    document.getElementById('accountStateHelp').textContent = isOffline
        ? 'Reconnect Cynode to edit your account details or refresh organization and plan data.'
        : `Desktop, browser, and PWA surfaces will use this same account state. ${orgSummary}`;

    const nameInput = document.getElementById('displayName');
    const emailInput = document.getElementById('email');
    const avatarUrlInput = document.getElementById('avatarUrl');
    nameInput.value = user.displayName || '';
    emailInput.value = user.email || '';
    avatarUrlInput.value = user.avatarUrl || '';

    setAvatarPreview(user.avatarUrl || '');
    renderMemberships(me);
}

function setFormsDisabled(disabled) {
    const ids = [
        'displayName',
        'email',
        'avatarUrl',
        'saveProfileBtn',
        'currentPassword',
        'newPassword',
        'confirmPassword',
        'savePasswordBtn',
    ];

    ids.forEach((id) => {
        const element = document.getElementById(id);
        if (!element) return;
        element.disabled = !!disabled;
    });
}

async function apiJson(url, options = {}) {
    let res;
    try {
        res = await fetch(url, options);
    } catch (error) {
        if (url.includes('/api/v1/me')) {
            const cached = readCachedMe();
            if (cached) return { ...cached, offline: true };
        }
        throw error;
    }

    if (!res.ok) {
        if ((res.status === 502 || res.status === 503 || res.status === 504) && url.includes('/api/v1/me')) {
            const cached = readCachedMe();
            if (cached) return { ...cached, offline: true };
        }
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `API ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    if (url.includes('/api/v1/me') && json && json.user) {
        writeCachedMe(json);
    }
    return json;
}

document.addEventListener('DOMContentLoaded', async () => {
    const profileForm = document.getElementById('profileForm');
    const passwordForm = document.getElementById('passwordForm');
    const profileStatus = document.getElementById('profileStatus');
    const passwordStatus = document.getElementById('passwordStatus');
    const emailInput = document.getElementById('email');
    const nameInput = document.getElementById('displayName');
    const avatarUrlInput = document.getElementById('avatarUrl');

    async function loadProfile() {
        const me = await apiJson('/api/v1/me');
        if (!me || !me.user) {
            window.location.href = '/';
            return null;
        }

        renderProfile(me);
        if (me.offline) {
            setStatus(profileStatus, 'status-success', 'Offline profile view loaded from this device. Reconnect Cynode to edit account details.');
            setFormsDisabled(true);
        } else {
            setFormsDisabled(false);
        }
        return me;
    }

    try {
        await loadProfile();
    } catch (_) {
        window.location.href = '/';
        return;
    }

    profileForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        setStatus(profileStatus, '', '');

        const saveBtn = document.getElementById('saveProfileBtn');
        saveBtn.disabled = true;
        saveBtn.textContent = 'Updating...';

        try {
            await apiJson('/api/v1/user/profile', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    displayName: nameInput.value.trim() || null,
                    email: emailInput.value.trim() || null,
                    avatarUrl: avatarUrlInput.value.trim() || null,
                }),
            });

            await loadProfile();
            setStatus(profileStatus, 'status-success', 'Profile updated successfully.');
        } catch (err) {
            setStatus(profileStatus, 'status-error', err.message || 'Failed to update profile.');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Update Profile';
        }
    });

    passwordForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        setStatus(passwordStatus, '', '');

        const currentPass = document.getElementById('currentPassword').value;
        const newPass = document.getElementById('newPassword').value;
        const confirmPass = document.getElementById('confirmPassword').value;

        if (newPass !== confirmPass) {
            setStatus(passwordStatus, 'status-error', 'Passwords do not match.');
            return;
        }

        const saveBtn = document.getElementById('savePasswordBtn');
        saveBtn.disabled = true;
        saveBtn.textContent = 'Updating...';

        try {
            await apiJson('/api/v1/user/password', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    currentPassword: currentPass,
                    newPassword: newPass,
                }),
            });

            setStatus(passwordStatus, 'status-success', 'Password changed successfully.');
            passwordForm.reset();
        } catch (err) {
            setStatus(passwordStatus, 'status-error', err.message || 'Failed to change password.');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Update Password';
        }
    });
});

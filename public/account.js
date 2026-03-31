/**
 * Cynode Account Management
 */

async function apiJson(url, options = {}) {
    const res = await fetch(url, options);
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `API ${res.status} ${res.statusText}`);
    }
    return res.json();
}

document.addEventListener('DOMContentLoaded', async () => {
    const profileForm = document.getElementById('profileForm');
    const passwordForm = document.getElementById('passwordForm');
    const profileStatus = document.getElementById('profileStatus');
    const passwordStatus = document.getElementById('passwordStatus');
    
    // View elements
    const viewHandle = document.getElementById('viewHandle');
    const viewId = document.getElementById('viewId');
    const emailInput = document.getElementById('email');
    const nameInput = document.getElementById('displayName');

    // Load current profile
    try {
        const me = await apiJson('/api/v1/me');
        if (!me || !me.user) {
            window.location.href = '/'; // Unauthorized
            return;
        }
        
        viewHandle.textContent = `@${me.user.handle}`;
        viewId.textContent = me.user.id;
        emailInput.value = me.user.email || '';
        nameInput.value = me.user.displayName || '';

    } catch (e) {
        window.location.href = '/';
    }

    // Update Profile
    profileForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        profileStatus.className = 'status-msg';
        profileStatus.textContent = '';
        
        const saveBtn = document.getElementById('saveProfileBtn');
        saveBtn.disabled = true;
        saveBtn.textContent = 'Updating...';

        try {
            await apiJson('/api/v1/user/profile', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    displayName: nameInput.value.trim(),
                    email: emailInput.value.trim()
                })
            });
            
            profileStatus.className = 'status-msg status-success';
            profileStatus.textContent = 'Profile updated successfully!';
        } catch (err) {
            profileStatus.className = 'status-msg status-error';
            profileStatus.textContent = err.message || 'Failed to update profile.';
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Update Profile';
        }
    });

    // Update Password
    passwordForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        passwordStatus.className = 'status-msg';
        passwordStatus.textContent = '';

        const currentPass = document.getElementById('currentPassword').value;
        const newPass = document.getElementById('newPassword').value;
        const confirmPass = document.getElementById('confirmPassword').value;

        if (newPass !== confirmPass) {
            passwordStatus.className = 'status-msg status-error';
            passwordStatus.textContent = 'Passwords do not match.';
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
                    newPassword: newPass
                })
            });
            
            passwordStatus.className = 'status-msg status-success';
            passwordStatus.textContent = 'Password changed successfully!';
            passwordForm.reset();
        } catch (err) {
            passwordStatus.className = 'status-msg status-error';
            passwordStatus.textContent = err.message || 'Failed to change password.';
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Update Password';
        }
    });
});

/**
 * Offline-First Sync Queue
 * 
 * Queues mutations (save graph, update profile, etc.) when offline.
 * Replays them with conflict resolution when connectivity is restored.
 * Works across web, desktop, and PWA platforms.
 */

const SYNC_QUEUE_DB_NAME = 'CynodeSyncQueue';
const SYNC_QUEUE_STORE_NAME = 'mutations';
const SYNC_QUEUE_VERSION = 1;

let syncDB = null;
let isOnline = typeof navigator !== 'undefined' && navigator.onLine;
let syncQueueInFlight = false;

/**
 * Initialize IndexedDB for sync queue storage
 */
async function initSyncQueueDB() {
  return new Promise((resolve, reject) => {
    if (syncDB) return resolve(syncDB);
    
    const request = indexedDB.open(SYNC_QUEUE_DB_NAME, SYNC_QUEUE_VERSION);
    
    request.onerror = () => {
      console.error('[SyncQueue] Failed to open DB:', request.error);
      reject(request.error);
    };
    
    request.onsuccess = () => {
      syncDB = request.result;
      console.log('[SyncQueue] DB initialized');
      resolve(syncDB);
    };
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(SYNC_QUEUE_STORE_NAME)) {
        const store = db.createObjectStore(SYNC_QUEUE_STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('status', 'status', { unique: false });
        console.log('[SyncQueue] ObjectStore created');
      }
    };
  });
}

/**
 * Queue a mutation for sync
 * @param {string} action - Type of mutation (e.g., 'save_graph', 'update_profile', 'create_share')
 * @param {object} payload - Data to send with the mutation
 * @param {object} options - Additional options
 * @returns {Promise<number>} Queue ID
 */
async function queueMutation(action, payload, options = {}) {
  try {
    const db = await initSyncQueueDB();
    const transaction = db.transaction([SYNC_QUEUE_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(SYNC_QUEUE_STORE_NAME);
    
    const mutation = {
      action,
      payload,
      status: 'pending',
      timestamp: Date.now(),
      retries: 0,
      maxRetries: options.maxRetries ?? 5,
      endpoint: options.endpoint || '/api/v1/sync/apply',
      method: options.method || 'POST',
      important: options.important ?? false,
    };
    
    return new Promise((resolve, reject) => {
      const request = store.add(mutation);
      request.onsuccess = () => {
        console.log(`[SyncQueue] Queued ${action} (#${request.result})`);
        resolve(request.result);
        // Try to flush queue if online
        if (isOnline) flushSyncQueue();
      };
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('[SyncQueue] Failed to queue mutation:', err);
    throw err;
  }
}

/**
 * Get all queued mutations
 * @returns {Promise<Array>} List of pending mutations
 */
async function getPendingMutations() {
  try {
    const db = await initSyncQueueDB();
    const transaction = db.transaction([SYNC_QUEUE_STORE_NAME], 'readonly');
    const store = transaction.objectStore(SYNC_QUEUE_STORE_NAME);
    const index = store.index('status');
    
    return new Promise((resolve, reject) => {
      const request = index.getAll('pending');
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('[SyncQueue] Failed to get pending mutations:', err);
    return [];
  }
}

/**
 * Update mutation status in queue
 * @param {number} id - Mutation ID
 * @param {string} status - New status ('pending', 'synced', 'failed', 'conflict')
 * @param {object} metadata - Additional metadata to store
 */
async function updateMutationStatus(id, status, metadata = {}) {
  try {
    const db = await initSyncQueueDB();
    const transaction = db.transaction([SYNC_QUEUE_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(SYNC_QUEUE_STORE_NAME);
    
    return new Promise((resolve, reject) => {
      const getRequest = store.get(id);
      getRequest.onsuccess = () => {
        const mutation = getRequest.result;
        if (mutation) {
          mutation.status = status;
          mutation.lastUpdated = Date.now();
          mutation.metadata = { ...mutation.metadata, ...metadata };
          
          const updateRequest = store.put(mutation);
          updateRequest.onsuccess = () => {
            console.log(`[SyncQueue] Updated #${id} to ${status}`);
            resolve(mutation);
          };
          updateRequest.onerror = () => reject(updateRequest.error);
        } else {
          reject(new Error(`Mutation #${id} not found`));
        }
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
  } catch (err) {
    console.error('[SyncQueue] Failed to update mutation status:', err);
    throw err;
  }
}

/**
 * Flush sync queue: replay pending mutations to the server
 * @param {object} options - Flush options
 */
async function flushSyncQueue(options = {}) {
  if (syncQueueInFlight || !isOnline) return;
  
  syncQueueInFlight = true;
  try {
    const mutations = await getPendingMutations();
    if (!mutations.length) {
      console.log('[SyncQueue] No pending mutations to flush');
      return;
    }
    
    console.log(`[SyncQueue] Flushing ${mutations.length} pending mutations...`);
    
    for (const mutation of mutations) {
      try {
        const response = await fetch(mutation.endpoint, {
          method: mutation.method,
          headers: {
            'Content-Type': 'application/json',
            'X-Sync-Queue-ID': String(mutation.id),
          },
          body: JSON.stringify(mutation.payload),
          credentials: 'include',
          cache: 'no-store',
        });
        
        if (response.ok) {
          const result = await response.json();
          await updateMutationStatus(mutation.id, 'synced', { serverResponse: result });
          console.log(`[SyncQueue] ✓ Synced #${mutation.id} (${mutation.action})`);
        } else if (response.status === 409) {
          // Conflict: server has fresher data
          const conflict = await response.json();
          await updateMutationStatus(mutation.id, 'conflict', { serverData: conflict });
          console.warn(`[SyncQueue] ⚠ Conflict on #${mutation.id}: server data is fresher`);
          // Could trigger UI to show conflict resolution UI
          window.dispatchEvent(new CustomEvent('cynode:syncconflict', { detail: { mutationId: mutation.id, ...conflict } }));
        } else if (response.status >= 500 || (response.status >= 400 && response.status < 409)) {
          // Retryable error
          mutation.retries = (mutation.retries || 0) + 1;
          if (mutation.retries < mutation.maxRetries) {
            await updateMutationStatus(mutation.id, 'pending', { retries: mutation.retries });
            console.warn(`[SyncQueue] Retry ${mutation.retries}/${mutation.maxRetries} for #${mutation.id}`);
          } else {
            await updateMutationStatus(mutation.id, 'failed', { reason: 'Max retries exceeded' });
            console.error(`[SyncQueue] ✗ Failed to sync #${mutation.id} after ${mutation.maxRetries} retries`);
          }
        }
      } catch (err) {
        console.error(`[SyncQueue] Error syncing #${mutation.id}:`, err);
        mutation.retries = (mutation.retries || 0) + 1;
        if (mutation.retries < mutation.maxRetries) {
          await updateMutationStatus(mutation.id, 'pending', { retries: mutation.retries });
        } else {
          await updateMutationStatus(mutation.id, 'failed', { reason: err.message });
        }
      }
    }
  } finally {
    syncQueueInFlight = false;
  }
}

/**
 * Clear all synced mutations from queue (housekeeping)
 */
async function clearSyncedMutations() {
  try {
    const db = await initSyncQueueDB();
    const transaction = db.transaction([SYNC_QUEUE_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(SYNC_QUEUE_STORE_NAME);
    const index = store.index('status');
    
    return new Promise((resolve, reject) => {
      const request = index.openCursor(IDBKeyRange.only('synced'));
      const toDelete = [];
      
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          toDelete.push(cursor.primaryKey);
          cursor.continue();
        } else {
          // Delete all synced mutations
          for (const key of toDelete) {
            store.delete(key);
          }
          console.log(`[SyncQueue] Cleared ${toDelete.length} synced mutations`);
          resolve(toDelete.length);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('[SyncQueue] Failed to clear synced mutations:', err);
  }
}

/**
 * Monitor online/offline status and flush queue when connectivity restored
 */
function monitorConnectivity() {
  const onOnline = () => {
    isOnline = true;
    console.log('[SyncQueue] Online - flushing queue');
    flushSyncQueue();
  };
  
  const onOffline = () => {
    isOnline = false;
    console.log('[SyncQueue] Offline - queueing mutations');
  };
  
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  
  // Periodic flush attempt (every 30 seconds) if online
  setInterval(() => {
    if (isOnline && !syncQueueInFlight) {
      flushSyncQueue().catch(err => console.warn('[SyncQueue] Periodic flush error:', err));
    }
  }, 30000);
}

/**
 * Initialize the sync queue system
 */
async function initSyncQueue() {
  try {
    if (!('indexedDB' in window)) {
      console.warn('[SyncQueue] IndexedDB not available, offline sync disabled');
      return false;
    }
    
    await initSyncQueueDB();
    monitorConnectivity();
    
    // Clear old synced mutations on startup
    setTimeout(() => clearSyncedMutations(), 5000);
    
    console.log('[SyncQueue] Initialized');
    return true;
  } catch (err) {
    console.error('[SyncQueue] Failed to initialize:', err);
    return false;
  }
}

// Auto-initialize on script load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSyncQueue);
} else {
  initSyncQueue();
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    queueMutation,
    getPendingMutations,
    updateMutationStatus,
    flushSyncQueue,
    clearSyncedMutations,
    initSyncQueue,
    getSyncQueueStatus: () => ({ isOnline, syncQueueInFlight }),
  };
}

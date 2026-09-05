// PDF bytes live in IndexedDB, never in the small JSON progress record.
// Enqueue acknowledges only after the transaction commits. Unreferenced files
// are collected at worker startup after an interrupted enqueue or cleanup.
export function createQueuedPdfStore(factory = globalThis.indexedDB) {
    let opening;
    function open() {
        if (!opening) opening = new Promise((resolve, reject) => {
            const request = factory.open('scholar-relay-pdfs', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('files');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => { opening = null; reject(request.error); };
        });
        return opening;
    }
    async function transact(mode, operation) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('files', mode);
            let result;
            tx.oncomplete = () => resolve(result);
            tx.onabort = tx.onerror = () => reject(tx.error || new Error('Could not save queued PDF.'));
            const request = operation(tx.objectStore('files'));
            if (request) request.onsuccess = () => { result = request.result; };
        });
    }
    return {
        async put(id, file) {
            // Ask Chrome to protect stored jobs from storage-pressure eviction.
            await globalThis.navigator?.storage?.persist?.();
            return transact('readwrite', store => store.put(file, id));
        },
        get: id => transact('readonly', store => store.get(id)),
        remove: id => transact('readwrite', store => store.delete(id)),
        async prune(keepIds) {
            const ids = await transact('readonly', store => store.getAllKeys());
            await transact('readwrite', store => {
                for (const id of ids) if (!keepIds.includes(id)) store.delete(id);
            });
        },
    };
}

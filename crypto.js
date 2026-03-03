const CryptoUtils = {
    isSupported: () => !!(window.crypto && window.crypto.subtle),

    /**
     * Generate an ECDH key pair for key exchange
     */
    generateECCKeyPair: async () => {
        return await window.crypto.subtle.generateKey(
            { name: "ECDH", namedCurve: "P-256" },
            true,
            ["deriveKey"]
        );
    },

    /**
     * Export public key as ArrayBuffer
     */
    exportPublicKey: async (key) => {
        return await window.crypto.subtle.exportKey("spki", key);
    },

    /**
     * Import peer's public key from ArrayBuffer
     */
    importPublicKey: async (keyData) => {
        return await window.crypto.subtle.importKey(
            "spki", keyData, { name: "ECDH", namedCurve: "P-256" }, true, []
        );
    },

    /**
     * Derive a shared AES-GCM key
     */
    deriveEncryptionKey: async (privateKey, peerPublicKey) => {
        return await window.crypto.subtle.deriveKey(
            { name: "ECDH", public: peerPublicKey }, privateKey,
            { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
        );
    },

    /**
     * Encrypt a data chunk using AES-GCM
     */
    encryptChunk: async (data, key) => {
        const encoded = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encryptedData = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
        return { encryptedData, iv };
    },

    /**
     * Decrypt a data chunk using AES-GCM
     */
    decryptChunk: async (enc, key, iv) => {
        const dec = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, enc);
        return new TextDecoder().decode(dec);
    },

    /**
     * Create/Verify Bindings (Strict SHA-256)
     */
    createKeyBinding: async (peerId, pub, ts) => {
        const str = peerId + ts;
        const hash = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
        return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    },

    verifyKeyBinding: async (peerId, pub, ts, binding) => {
        return (await CryptoUtils.createKeyBinding(peerId, pub, ts)) === binding;
    },

    generateFingerprint: async (pub) => {
        const hash = await window.crypto.subtle.digest("SHA-256", pub);
        return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
    }
};

export default CryptoUtils;

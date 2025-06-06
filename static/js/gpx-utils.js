// Simple CRC32 calculation for PNG chunks
function calculateCRC32(data) {
    const crcTable = new Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        crcTable[i] = c;
    }
    
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Function to add DPI metadata to PNG
function addPngDpiMetadata(pngData, pixelsPerMeter) {
    try {
        // PNG signature: 89 50 4E 47 0D 0A 1A 0A
        if (pngData[0] !== 0x89 || pngData[1] !== 0x50 || pngData[2] !== 0x4E || pngData[3] !== 0x47) {
            throw new Error('Not a valid PNG file');
        }
        
        // Find the IDAT chunk to insert pHYs before it
        let insertPosition = 8; // Start after PNG signature
        
        while (insertPosition < pngData.length - 8) {
            const chunkLength = (pngData[insertPosition] << 24) | (pngData[insertPosition + 1] << 16) | 
                              (pngData[insertPosition + 2] << 8) | pngData[insertPosition + 3];
            const chunkType = String.fromCharCode(pngData[insertPosition + 4], pngData[insertPosition + 5], 
                                                pngData[insertPosition + 6], pngData[insertPosition + 7]);
            
            if (chunkType === 'IDAT') {
                break;
            }
            
            insertPosition += 8 + chunkLength + 4; // 8 bytes header + data + 4 bytes CRC
        }
        
        // Create pHYs chunk
        const physChunk = new Uint8Array(21); // 4 length + 4 type + 9 data + 4 CRC
        
        // Length (9 bytes)
        physChunk[0] = 0x00;
        physChunk[1] = 0x00;
        physChunk[2] = 0x00;
        physChunk[3] = 0x09;
        
        // Type "pHYs"
        physChunk[4] = 0x70; // p
        physChunk[5] = 0x48; // H
        physChunk[6] = 0x59; // Y
        physChunk[7] = 0x73; // s
        
        // Data: pixels per unit X (4 bytes) + pixels per unit Y (4 bytes) + unit specifier (1 byte)
        physChunk[8] = (pixelsPerMeter >>> 24) & 0xFF;
        physChunk[9] = (pixelsPerMeter >>> 16) & 0xFF;
        physChunk[10] = (pixelsPerMeter >>> 8) & 0xFF;
        physChunk[11] = pixelsPerMeter & 0xFF;
        
        physChunk[12] = (pixelsPerMeter >>> 24) & 0xFF;
        physChunk[13] = (pixelsPerMeter >>> 16) & 0xFF;
        physChunk[14] = (pixelsPerMeter >>> 8) & 0xFF;
        physChunk[15] = pixelsPerMeter & 0xFF;
        
        physChunk[16] = 0x01; // Unit: meters
        
        // Calculate CRC32 for type + data
        const crc = calculateCRC32(physChunk.slice(4, 17));
        physChunk[17] = (crc >>> 24) & 0xFF;
        physChunk[18] = (crc >>> 16) & 0xFF;
        physChunk[19] = (crc >>> 8) & 0xFF;
        physChunk[20] = crc & 0xFF;
        
        // Insert pHYs chunk
        const result = new Uint8Array(pngData.length + 21);
        result.set(pngData.slice(0, insertPosition));
        result.set(physChunk, insertPosition);
        result.set(pngData.slice(insertPosition), insertPosition + 21);
        
        return result;
    } catch (error) {
        console.warn('Failed to add DPI metadata:', error);
        return pngData; // Return original if modification fails
    }
}

// Show toast notification function
function showToast(message, type = 'info', duration = 3000) {
    // Check if toast container exists, create if not
    let toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        toastContainer.className = 'fixed top-4 right-4 z-50 space-y-2';
        document.body.appendChild(toastContainer);
    }

    // Create toast element
    const toast = document.createElement('div');
    const bgColor = type === 'error' ? 'bg-red-500' : type === 'success' ? 'bg-green-500' : 'bg-blue-500';
    toast.className = `${bgColor} text-white px-6 py-3 rounded-lg shadow-lg transform transition-all duration-300 ease-in-out translate-x-full opacity-0`;
    toast.textContent = message;

    toastContainer.appendChild(toast);

    // Animate in
    setTimeout(() => {
        toast.classList.remove('translate-x-full', 'opacity-0');
    }, 10);

    // Auto-remove after duration
    setTimeout(() => {
        toast.classList.add('translate-x-full', 'opacity-0');
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }, duration);
}

// Export functions to make them available globally or to other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { calculateCRC32, addPngDpiMetadata, showToast };
} 
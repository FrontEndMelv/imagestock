const crypto = require('crypto');

/**
 * Generate a signed URL for secure temporary access.
 * @param {string} url - The base URL (can already include query params).
 * @param {number} lifetime - Validity in seconds.
 * @returns {string} Signed URL with exp & sig query params appended.
 */
function generateSignedUrl(url, lifetime = 300) {
    const expiry = Math.floor(Date.now() / 1000) + lifetime;

    // Append exp param
    const parsed = new URL(url);
    parsed.searchParams.set("exp", expiry);

    // Compute signature
    const data = `${parsed.pathname}?${parsed.searchParams.toString()}`;
    const signature = crypto
        .createHmac('sha256', process.env.DOWNLOAD_SECRET)
        .update(data)
        .digest('hex');

    parsed.searchParams.set("sig", signature);
    return parsed.pathname + "?" + parsed.searchParams.toString();
}

/**
 * Verify a signed URL
 * @param {string} fullPath - The full path + query string from request.url
 * @returns {boolean} Whether signature and expiry are valid
 */
function verifySignedUrl(fullPath) {
    const parsed = new URL(fullPath);

    const exp = parseInt(parsed.searchParams.get("exp"), 10);
    const sig = parsed.searchParams.get("sig");
    if (!exp || !sig) return false;

    const now = Math.floor(Date.now() / 1000);
    if (now > exp) return false;

    // Recompute expected signature
    parsed.searchParams.delete("sig"); // remove before recomputing
    const data = `${parsed.pathname}?${parsed.searchParams.toString()}`;
    const expectedSig = crypto
        .createHmac('sha256', process.env.DOWNLOAD_SECRET)
        .update(data)
        .digest('hex');

    try {
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
    } catch {
        return false;
    }
}

module.exports = {
  generateSignedUrl,
  verifySignedUrl
}

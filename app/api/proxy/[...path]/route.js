import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function getTargetFromPath(req) {
    const pathname = req.nextUrl.pathname;
    const prefix = '/api/proxy/';

    if (!pathname.startsWith(prefix)) {
        return null;
    }

    let encodedTarget = pathname.slice(prefix.length);

    if (!encodedTarget) {
        return null;
    }

    try {
        encodedTarget = decodeURIComponent(encodedTarget);
    } catch {
        // Keep original value if decoding fails
    }

    if (
        encodedTarget.startsWith('https:/') &&
        !encodedTarget.startsWith('https://')
    ) {
        encodedTarget = encodedTarget.replace(/^https:\//, 'https://');
    }

    if (
        encodedTarget.startsWith('http:/') &&
        !encodedTarget.startsWith('http://')
    ) {
        encodedTarget = encodedTarget.replace(/^http:\//, 'http://');
    }

    return encodedTarget;
}

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods':
            'GET, HEAD, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
            'Range, Accept, Content-Type, Origin, Referer, User-Agent, Authorization',
        'Access-Control-Expose-Headers':
            'Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified',
        'Access-Control-Max-Age': '86400',
    };
}

/**
 * Automatically rewrites internal URLs inside DASH (.mpd) and HLS (.m3u8) manifests
 * so that all media chunks route through this proxy automatically.
 */
function rewriteManifestContent(manifestText, targetUrl, proxyBaseUrl) {
    const targetBase = new URL('.', targetUrl).toString();

    const makeProxiedUrl = (originalLink) => {
        let absoluteUrl;
        try {
            absoluteUrl = new URL(originalLink, targetBase).toString();
        } catch {
            return originalLink;
        }
        return `${proxyBaseUrl}${absoluteUrl}`;
    };

    // 1. DASH (.mpd) Manifest Rewriting
    let rewritten = manifestText.replace(
        /(media|initialization|sourceURL)=["']([^"']+)["']/g,
        (match, attr, link) => {
            return `${attr}="${makeProxiedUrl(link)}"`;
        }
    );

    // 2. HLS (.m3u8) Manifest Rewriting
    const lines = rewritten.split('\n');
    const processedLines = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            if (trimmed.includes('URI="')) {
                return trimmed.replace(/URI="([^"]+)"/, (m, uri) => `URI="${makeProxiedUrl(uri)}"`);
            }
            return line;
        }
        return makeProxiedUrl(trimmed);
    });

    return processedLines.join('\n');
}

async function handleProxy(req) {
    try {
        let rawTarget = getTargetFromPath(req);

        // Crucial: Append query parameters (tokens, keys, etc.) back onto the target URL
        if (req.nextUrl.search) {
            rawTarget += req.nextUrl.search;
        }

        if (!rawTarget) {
            return NextResponse.json({ error: 'Missing target URL' }, { status: 400, headers: corsHeaders() });
        }

        let targetUrl;
        try {
            targetUrl = new URL(rawTarget);
        } catch {
            return NextResponse.json({ error: 'Invalid target URL', target: rawTarget }, { status: 400, headers: corsHeaders() });
        }

        if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
            return NextResponse.json({ error: 'Only HTTP and HTTPS URLs are allowed' }, { status: 400, headers: corsHeaders() });
        }

        const upstreamHeaders = new Headers();
        const userAgent = req.headers.get('user-agent') || DEFAULT_UA;
        const referer = req.headers.get('referer') || `${targetUrl.origin}/`;

        upstreamHeaders.set('User-Agent', userAgent);
        upstreamHeaders.set('Accept', '*/*');
        upstreamHeaders.set('Referer', referer);

        const origin = req.headers.get('origin');
        if (origin) upstreamHeaders.set('Origin', origin);

        const range = req.headers.get('range');
        if (range) upstreamHeaders.set('Range', range);

        const accept = req.headers.get('accept');
        if (accept) upstreamHeaders.set('Accept', accept);

        const contentType = req.headers.get('content-type');
        if (contentType) upstreamHeaders.set('Content-Type', contentType);

        const authorization = req.headers.get('authorization');
        if (authorization) upstreamHeaders.set('Authorization', authorization);

        const fetchOptions = {
            method: req.method,
            headers: upstreamHeaders,
            redirect: 'follow',
            cache: 'no-store',
        };

        if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
            fetchOptions.body = await req.arrayBuffer();
        }

        const upstreamResponse = await fetch(targetUrl.toString(), fetchOptions);
        const upstreamContentType = upstreamResponse.headers.get('content-type') || '';

        const responseHeaders = new Headers();
        const allowedHeaders = [
            'content-type', 'content-length', 'content-range', 'accept-ranges',
            'cache-control', 'etag', 'last-modified', 'expires', 'content-encoding',
            'content-disposition', 'vary',
        ];

        for (const name of allowedHeaders) {
            const value = upstreamResponse.headers.get(name);
            if (value) responseHeaders.set(name, value);
        }

        const cors = corsHeaders();
        for (const [key, value] of Object.entries(cors)) {
            responseHeaders.set(key, value);
        }

        // Check if the response is a manifest file (.mpd or .m3u8)
        const isManifest = 
            targetUrl.pathname.endsWith('.mpd') ||
            targetUrl.pathname.endsWith('.m3u8') ||
            upstreamContentType.includes('xml') ||
            upstreamContentType.includes('dash') ||
            upstreamContentType.includes('mpegurl');

        if (isManifest) {
            const manifestText = await upstreamResponse.text();
            
            const host = req.headers.get('host') || 'your-project.vercel.app';
            const protocol = req.headers.get('x-forwarded-proto') || 'https';
            const proxyBaseUrl = `${protocol}://${host}/api/proxy/`;

            const rewrittenManifest = rewriteManifestContent(manifestText, targetUrl.toString(), proxyBaseUrl);

            responseHeaders.delete('content-encoding');
            responseHeaders.set('content-length', Buffer.byteLength(rewrittenManifest));

            return new NextResponse(rewrittenManifest, {
                status: upstreamResponse.status,
                statusText: upstreamResponse.statusText,
                headers: responseHeaders,
            });
        }

        // Stream regular binary chunks (.m4s, .ts segments) directly
        return new NextResponse(upstreamResponse.body, {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: responseHeaders,
        });

    } catch (error) {
        console.error('CORS Proxy Error:', error);
        return NextResponse.json(
            { error: 'Proxy fetch failed', details: error instanceof Error ? error.message : String(error) },
            { status: 502, headers: corsHeaders() }
        );
    }
}

export async function GET(req) { return handleProxy(req); }
export async function HEAD(req) { return handleProxy(req); }
export async function POST(req) { return handleProxy(req); }
export async function PUT(req) { return handleProxy(req); }
export async function DELETE(req) { return handleProxy(req); }
export async function OPTIONS() {
    return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* =========================================================
   CONFIGURATION
========================================================= */

const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/122.0.0.0 Safari/537.36';

/*
 * Suffix matching: 'example.com' also allows
 * 'cdn.example.com', 'a.b.example.com', etc.
 * Segment CDNs are often on a different subdomain than
 * the manifest, so exact matching breaks playback.
 */
const ALLOWED_HOSTS = [
    'your-domain.com',
];

function isAllowedHost(hostname) {
    const host = hostname.toLowerCase();
    return ALLOWED_HOSTS.some(
        allowed => host === allowed || host.endsWith('.' + allowed)
    );
}


/* =========================================================
   CORS HEADERS
========================================================= */

function corsHeaders(req) {
    const requested = req?.headers.get(
        'access-control-request-headers'
    );

    return {
        'Access-Control-Allow-Origin': '*',

        'Access-Control-Allow-Methods':
            'GET, HEAD, POST, PUT, DELETE, OPTIONS',

        'Access-Control-Allow-Headers':
            requested ||
            'Range, Accept, Content-Type, Origin, Referer, ' +
            'User-Agent, Authorization, X-Requested-With',

        /*
         * Players need these readable. Date matters for
         * live DASH UTC clock sync in dash.js.
         */
        'Access-Control-Expose-Headers':
            'Accept-Ranges, Content-Length, Content-Range, ' +
            'Content-Type, ETag, Last-Modified, Date, Server-Timing',

        'Access-Control-Max-Age': '86400',
        'Timing-Allow-Origin': '*',
    };
}


/* =========================================================
   GET TARGET URL

   Preferred form:  /api/proxy?url=<encodeURIComponent(target)>
   Legacy form:     /api/proxy/<target>
========================================================= */

function getTarget(req) {
    const fromQuery = req.nextUrl.searchParams.get('url');
    if (fromQuery) {
        return fromQuery;
    }

    const prefix = '/api/proxy/';
    const pathname = req.nextUrl.pathname;

    if (!pathname.startsWith(prefix)) {
        return null;
    }

    let rawTarget = pathname.slice(prefix.length);
    if (!rawTarget) {
        return null;
    }

    if (rawTarget.includes('%')) {
        try {
            rawTarget = decodeURIComponent(rawTarget);
        } catch {
            // keep original if decoding fails
        }
    }

    // Repair protocol slashes flattened by routing
    rawTarget = rawTarget
        .replace(/^https:\/+/, 'https://')
        .replace(/^http:\/+/, 'http://');

    /*
     * Only append our own query string if the decoded
     * target does not already carry one. Otherwise you
     * get "?a=1?b=2".
     */
    const search = req.nextUrl.search;
    if (search && !rawTarget.includes('?')) {
        rawTarget += search;
    }

    return rawTarget;
}


/* =========================================================
   COPY RESPONSE HEADERS
========================================================= */

function copyResponseHeaders(upstreamHeaders, req) {
    const headers = new Headers();

    const allowedHeaders = [
        'content-type',
        'content-range',
        'accept-ranges',
        'cache-control',
        'etag',
        'last-modified',
        'expires',
        'content-disposition',
    ];

    for (const name of allowedHeaders) {
        const value = upstreamHeaders.get(name);
        if (value) {
            headers.set(name, value);
        }
    }

    /*
     * NEVER forward content-encoding: fetch has already
     * decompressed the body. Forwarding it makes the
     * browser try to gunzip plain bytes.
     *
     * content-length is only safe when the body was not
     * compressed upstream.
     */
    const upstreamEncoding = (
        upstreamHeaders.get('content-encoding') || ''
    ).toLowerCase();

    const wasCompressed =
        upstreamEncoding &&
        upstreamEncoding !== 'identity';

    if (!wasCompressed) {
        const length = upstreamHeaders.get('content-length');
        if (length) {
            headers.set('content-length', length);
        }
    }

    const cors = corsHeaders(req);
    for (const [key, value] of Object.entries(cors)) {
        headers.set(key, value);
    }

    return headers;
}


/* =========================================================
   MAKE PROXY URL

   Placeholders like $Number$ / $Time$ / $RepresentationID$
   MUST survive encoding, or DASH segment templates break.
========================================================= */

const TEMPLATE_TOKEN = /%24([A-Za-z]+)(%24|(%25[0-9]+d)?%24)/g;

function restoreTemplateTokens(encoded) {
    // Turn %24Number%24 back into $Number$
    return encoded
        .replace(/%24/g, '$')
        .replace(/%25(0\d+d)/g, '%$1'); // $Number%05d$ formatting
}

function createProxyUrl(originalUrl, baseUrl, proxyBaseUrl) {
    try {
        const absoluteUrl = new URL(originalUrl, baseUrl).toString();
        const encoded = encodeURIComponent(absoluteUrl);

        return proxyBaseUrl + restoreTemplateTokens(encoded);
    } catch {
        return originalUrl;
    }
}


/* =========================================================
   REWRITE DASH MANIFEST
========================================================= */

function rewriteDashManifest(manifest, targetUrl, proxyBaseUrl) {
    const baseUrl = new URL('./', targetUrl).toString();

    // media / initialization / sourceURL attributes
    manifest = manifest.replace(
        /\b(media|initialization|sourceURL)=["']([^"']+)["']/gi,
        (match, attribute, value) => {
            const proxied = createProxyUrl(
                value,
                baseUrl,
                proxyBaseUrl
            );
            return `${attribute}="${proxied}"`;
        }
    );

    // <BaseURL>...</BaseURL>
    manifest = manifest.replace(
        /(<BaseURL[^>]*>)([^<]+)(<\/BaseURL>)/gi,
        (match, start, value, end) => {
            const trimmed = value.trim();
            if (!trimmed) {
                return match;
            }
            const proxied = createProxyUrl(
                trimmed,
                baseUrl,
                proxyBaseUrl
            );
            return `${start}${proxied}${end}`;
        }
    );

    // <Location> for live manifest relocation
    manifest = manifest.replace(
        /(<Location[^>]*>)([^<]+)(<\/Location>)/gi,
        (match, start, value, end) => {
            const trimmed = value.trim();
            if (!trimmed) {
                return match;
            }
            const proxied = createProxyUrl(
                trimmed,
                baseUrl,
                proxyBaseUrl
            );
            return `${start}${proxied}${end}`;
        }
    );

    // <UTCTiming value="https://..."> for live clock sync
    manifest = manifest.replace(
        /(<UTCTiming[^>]*\bvalue=)["']([^"']+)["']/gi,
        (match, start, value) => {
            if (!/^https?:\/\//i.test(value)) {
                return match;
            }
            const proxied = createProxyUrl(
                value,
                baseUrl,
                proxyBaseUrl
            );
            return `${start}"${proxied}"`;
        }
    );

    return manifest;
}


/* =========================================================
   REWRITE HLS MANIFEST
========================================================= */

function rewriteHlsManifest(manifest, targetUrl, proxyBaseUrl) {
    const baseUrl = new URL('./', targetUrl).toString();
    const lines = manifest.split(/\r?\n/);

    const result = lines.map(line => {
        const trimmed = line.trim();

        if (!trimmed) {
            return line;
        }

        // Covers #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA, etc.
        if (trimmed.startsWith('#')) {
            return line.replace(
                /URI="([^"]+)"/gi,
                (match, uri) => {
                    const proxied = createProxyUrl(
                        uri,
                        baseUrl,
                        proxyBaseUrl
                    );
                    return `URI="${proxied}"`;
                }
            );
        }

        return createProxyUrl(trimmed, baseUrl, proxyBaseUrl);
    });

    return result.join('\n');
}


/* =========================================================
   DETECT MANIFEST
========================================================= */

function isManifest(targetUrl, contentType) {
    const pathname = targetUrl.pathname.toLowerCase();
    const type = contentType.toLowerCase();

    if (pathname.endsWith('.mpd') || pathname.endsWith('.m3u8')) {
        return true;
    }

    return (
        type.includes('mpegurl') ||
        type.includes('dash+xml') ||
        type.includes('application/xml') ||
        type.includes('text/xml')
    );
}


/* =========================================================
   MAIN PROXY
========================================================= */

async function handleProxy(req) {
    try {
        const rawTarget = getTarget(req);

        if (!rawTarget) {
            return NextResponse.json(
                { error: 'Missing target URL' },
                { status: 400, headers: corsHeaders(req) }
            );
        }

        let targetUrl;
        try {
            targetUrl = new URL(rawTarget);
        } catch {
            return NextResponse.json(
                { error: 'Invalid target URL', target: rawTarget },
                { status: 400, headers: corsHeaders(req) }
            );
        }

        if (
            targetUrl.protocol !== 'http:' &&
            targetUrl.protocol !== 'https:'
        ) {
            return NextResponse.json(
                { error: 'Only HTTP and HTTPS URLs are allowed' },
                { status: 400, headers: corsHeaders(req) }
            );
        }

        if (!isAllowedHost(targetUrl.hostname)) {
            return NextResponse.json(
                {
                    error: 'Target host is not allowed',
                    host: targetUrl.hostname,
                },
                { status: 403, headers: corsHeaders(req) }
            );
        }

        const upstreamHeaders = new Headers();

        upstreamHeaders.set(
            'User-Agent',
            req.headers.get('user-agent') || DEFAULT_UA
        );
        upstreamHeaders.set(
            'Accept',
            req.headers.get('accept') || '*/*'
        );

        /*
         * Do NOT forward the browser's Referer/Origin.
         * Sending "http://localhost:3000" to a CDN with
         * hotlink protection gets you a 403. Present the
         * target's own origin instead.
         */
        upstreamHeaders.set('Referer', `${targetUrl.origin}/`);
        upstreamHeaders.set('Origin', targetUrl.origin);

        const range = req.headers.get('range');
        if (range) {
            upstreamHeaders.set('Range', range);
        }

        const authorization = req.headers.get('authorization');
        if (authorization) {
            upstreamHeaders.set('Authorization', authorization);
        }

        const requestContentType = req.headers.get('content-type');
        if (requestContentType) {
            upstreamHeaders.set('Content-Type', requestContentType);
        }

        const fetchOptions = {
            method: req.method,
            headers: upstreamHeaders,
            redirect: 'follow',
            cache: 'no-store',
        };

        if (
            req.method !== 'GET' &&
            req.method !== 'HEAD' &&
            req.method !== 'OPTIONS'
        ) {
            fetchOptions.body = await req.arrayBuffer();
        }

        const upstreamResponse = await fetch(
            targetUrl.toString(),
            fetchOptions
        );

        const contentType =
            upstreamResponse.headers.get('content-type') || '';

        const responseHeaders = copyResponseHeaders(
            upstreamResponse.headers,
            req
        );

        if (isManifest(targetUrl, contentType)) {
            const manifestText = await upstreamResponse.text();

            const host = req.headers.get('host');
            if (!host) {
                return NextResponse.json(
                    { error: 'Unable to determine proxy host' },
                    { status: 500, headers: corsHeaders(req) }
                );
            }

            const protocol =
                req.headers.get('x-forwarded-proto') ||
                (req.nextUrl.protocol || 'https:').replace(':', '');

            const proxyBaseUrl =
                `${protocol}://${host}/api/proxy?url=`;

            /*
             * Resolve relative URLs against the FINAL url
             * after redirects, not the requested one.
             */
            const effectiveUrl =
                upstreamResponse.url || targetUrl.toString();

            const isDash =
                new URL(effectiveUrl).pathname
                    .toLowerCase()
                    .endsWith('.mpd') ||
                contentType.toLowerCase().includes('dash+xml');

            const rewrittenManifest = isDash
                ? rewriteDashManifest(
                      manifestText,
                      effectiveUrl,
                      proxyBaseUrl
                  )
                : rewriteHlsManifest(
                      manifestText,
                      effectiveUrl,
                      proxyBaseUrl
                  );

            responseHeaders.delete('content-encoding');
            responseHeaders.delete('content-length');

            responseHeaders.set(
                'Content-Type',
                isDash
                    ? 'application/dash+xml'
                    : 'application/vnd.apple.mpegurl'
            );

            // Live manifests must not be cached
            responseHeaders.set(
                'Cache-Control',
                'no-store, no-cache, must-revalidate'
            );

            return new NextResponse(rewrittenManifest, {
                status: upstreamResponse.status,
                statusText: upstreamResponse.statusText,
                headers: responseHeaders,
            });
        }

        return new NextResponse(upstreamResponse.body, {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: responseHeaders,
        });

    } catch (error) {
        console.error('CORS Proxy Error:', error);

        return NextResponse.json(
            {
                error: 'Proxy fetch failed',
                details:
                    error instanceof Error
                        ? error.message
                        : String(error),
            },
            { status: 502, headers: corsHeaders(req) }
        );
    }
}


/* =========================================================
   HTTP METHODS
========================================================= */

export async function GET(req)    { return handleProxy(req); }
export async function HEAD(req)   { return handleProxy(req); }
export async function POST(req)   { return handleProxy(req); }
export async function PUT(req)    { return handleProxy(req); }
export async function DELETE(req) { return handleProxy(req); }


/* =========================================================
   CORS PREFLIGHT
========================================================= */

export async function OPTIONS(req) {
    return new NextResponse(null, {
        status: 204,
        headers: corsHeaders(req),
    });
}

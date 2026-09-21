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
 * IMPORTANT:
 * Add your streaming domains here so the security check 
 * allows them through.
 */

const ALLOWED_HOSTS = new Set([
    'livestream1.sunnxt.com',
    'livestream.sunnxt.com',
    'sunnxt.com',
    'livestream2.sunnxt.com',
]);


/* =========================================================
   CORS HEADERS
========================================================= */

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


/* =========================================================
   GET TARGET URL
========================================================= */

function getTargetFromPath(req) {

    const pathname = req.nextUrl.pathname;
    const search = req.nextUrl.search; // Capture search/query parameters (tokens, keys)
    const prefix = '/api/proxy/';

    if (!pathname.startsWith(prefix)) {
        return null;
    }

    let rawTarget = pathname.slice(prefix.length);

    if (!rawTarget) {
        return null;
    }

    /*
     * Decode URL-encoded target.
     */
    try {
        rawTarget = decodeURIComponent(rawTarget);
    } catch {
        // Keep original value.
    }

    /*
     * Repair routing that changed:
     * https:// into https:/
     */

    if (
        rawTarget.startsWith('https:/') &&
        !rawTarget.startsWith('https://')
    ) {
        rawTarget = rawTarget.replace(
            /^https:\//,
            'https://'
        );
    }

    if (
        rawTarget.startsWith('http:/') &&
        !rawTarget.startsWith('http://')
    ) {
        rawTarget = rawTarget.replace(
            /^http:\//,
            'http://'
        );
    }

    /*
     * Append query parameters back onto the target URL
     */
    if (search) {
        rawTarget += search;
    }

    return rawTarget;
}


/* =========================================================
   HOST VALIDATION
========================================================= */

function isAllowedHost(hostname) {

    hostname = hostname.toLowerCase();

    return ALLOWED_HOSTS.has(hostname);
}


/* =========================================================
   COPY RESPONSE HEADERS
========================================================= */

function copyResponseHeaders(upstreamHeaders) {

    const headers = new Headers();

    const allowedHeaders = [

        'content-type',

        'content-length',

        'content-range',

        'accept-ranges',

        'cache-control',

        'etag',

        'last-modified',

        'expires',

        'content-encoding',

        'content-disposition',

        'vary',

    ];

    for (const name of allowedHeaders) {

        const value =
            upstreamHeaders.get(name);

        if (value) {
            headers.set(name, value);
        }
    }

    /*
     * Add CORS headers.
     */

    const cors = corsHeaders();

    for (const [key, value]
        of Object.entries(cors)) {

        headers.set(key, value);
    }

    return headers;
}


/* =========================================================
   MAKE PROXY URL
========================================================= */

function createProxyUrl(
    originalUrl,
    baseUrl,
    proxyBaseUrl
) {

    try {

        /*
         * Convert relative URL into absolute URL.
         */
        const absoluteUrl =
            new URL(
                originalUrl,
                baseUrl
            ).toString();

        /*
         * Encode target so characters such as:
         * ? & = do not break the proxy route.
         */

        return (
            proxyBaseUrl +
            encodeURIComponent(absoluteUrl)
        );

    } catch {

        return originalUrl;
    }
}


/* =========================================================
   REWRITE DASH MANIFEST
========================================================= */

function rewriteDashManifest(
    manifest,
    targetUrl,
    proxyBaseUrl
) {

    const baseUrl =
        new URL(
            './',
            targetUrl
        ).toString();


    manifest = manifest.replace(
        /\b(media|initialization|sourceURL|index|indexRange)=["']([^"']+)["']/gi,

        (match, attribute, value) => {

            if (
                attribute.toLowerCase() ===
                'indexrange'
            ) {
                return match;
            }

            const proxied =
                createProxyUrl(
                    value,
                    baseUrl,
                    proxyBaseUrl
                );

            return `${attribute}="${proxied}"`;
        }
    );


    manifest = manifest.replace(
        /(<BaseURL[^>]*>)([^<]+)(<\/BaseURL>)/gi,

        (match, start, value, end) => {

            const trimmed =
                value.trim();

            if (!trimmed) {
                return match;
            }

            const proxied =
                createProxyUrl(
                    trimmed,
                    baseUrl,
                    proxyBaseUrl
                );

            return (
                `${start}${proxied}${end}`
            );
        }
    );


    return manifest;
}


/* =========================================================
   REWRITE HLS MANIFEST
========================================================= */

function rewriteHlsManifest(
    manifest,
    targetUrl,
    proxyBaseUrl
) {

    const baseUrl =
        new URL(
            './',
            targetUrl
        ).toString();


    const lines =
        manifest.split(/\r?\n/);


    const result = lines.map(line => {

        const trimmed =
            line.trim();

        if (!trimmed) {
            return line;
        }

        if (trimmed.startsWith('#')) {

            return line.replace(
                /URI="([^"]+)"/gi,

                (match, uri) => {

                    const proxied =
                        createProxyUrl(
                            uri,
                            baseUrl,
                            proxyBaseUrl
                        );

                    return `URI="${proxied}"`;
                }
            );
        }

        return createProxyUrl(
            trimmed,
            baseUrl,
            proxyBaseUrl
        );
    });


    return result.join('\n');
}


/* =========================================================
   DETECT MANIFEST
========================================================= */

function isManifest(
    targetUrl,
    contentType
) {

    const pathname =
        targetUrl.pathname.toLowerCase();

    const type =
        contentType.toLowerCase();

    if (
        pathname.endsWith('.mpd') ||
        pathname.endsWith('.m3u8')
    ) {
        return true;
    }

    if (
        type.includes('mpegurl') ||
        type.includes('vnd.apple.mpegurl') ||
        type.includes('dash+xml') ||
        type.includes('application/xml') ||
        type.includes('text/xml')
    ) {
        return true;
    }

    return false;
}


/* =========================================================
   MAIN PROXY
========================================================= */

async function handleProxy(req) {

    try {

        let rawTarget =
            getTargetFromPath(req);

        if (!rawTarget) {

            return NextResponse.json(
                {
                    error:
                        'Missing target URL',
                },
                {
                    status: 400,
                    headers:
                        corsHeaders(),
                }
            );
        }

        let targetUrl;

        try {

            targetUrl =
                new URL(rawTarget);

        } catch {

            return NextResponse.json(
                {
                    error:
                        'Invalid target URL',

                    target:
                        rawTarget,
                },
                {
                    status: 400,
                    headers:
                        corsHeaders(),
                }
            );
        }

        if (
            targetUrl.protocol !==
                'http:' &&

            targetUrl.protocol !==
                'https:'
        ) {

            return NextResponse.json(
                {
                    error:
                        'Only HTTP and HTTPS URLs are allowed',
                },
                {
                    status: 400,
                    headers:
                        corsHeaders(),
                }
            );
        }

        if (
            !isAllowedHost(
                targetUrl.hostname
            )
        ) {

            return NextResponse.json(
                {
                    error:
                        'Target host is not allowed',

                    host:
                        targetUrl.hostname,
                },
                {
                    status: 403,
                    headers:
                        corsHeaders(),
                }
            );
        }

        const upstreamHeaders =
            new Headers();

        const userAgent =
            req.headers.get(
                'user-agent'
            ) || DEFAULT_UA;

        upstreamHeaders.set(
            'User-Agent',
            userAgent
        );

        upstreamHeaders.set(
            'Accept',
            req.headers.get(
                'accept'
            ) || '*/*'
        );

        const referer =
            req.headers.get(
                'referer'
            ) ||
            `${targetUrl.origin}/`;

        upstreamHeaders.set(
            'Referer',
            referer
        );

        const origin =
            req.headers.get(
                'origin'
            );

        if (origin) {

            upstreamHeaders.set(
                'Origin',
                origin
            );
        }

        const range =
            req.headers.get(
                'range'
            );

        if (range) {

            upstreamHeaders.set(
                'Range',
                range
            );
        }

        const authorization =
            req.headers.get(
                'authorization'
            );

        if (authorization) {

            upstreamHeaders.set(
                'Authorization',
                authorization
            );
        }

        const requestContentType =
            req.headers.get(
                'content-type'
            );

        if (requestContentType) {

            upstreamHeaders.set(
                'Content-Type',
                requestContentType
            );
        }

        const fetchOptions = {

            method:
                req.method,

            headers:
                upstreamHeaders,

            redirect:
                'follow',

            cache:
                'no-store',

        };

        if (
            req.method !== 'GET' &&
            req.method !== 'HEAD' &&
            req.method !== 'OPTIONS'
        ) {

            fetchOptions.body =
                await req.arrayBuffer();
        }

        const upstreamResponse =
            await fetch(
                targetUrl.toString(),
                fetchOptions
            );

        const contentType =
            upstreamResponse.headers.get(
                'content-type'
            ) || '';

        const responseHeaders =
            copyResponseHeaders(
                upstreamResponse.headers
            );

        if (
            isManifest(
                targetUrl,
                contentType
            )
        ) {

            const manifestText =
                await upstreamResponse.text();

            const host =
                req.headers.get(
                    'host'
                );

            if (!host) {

                return NextResponse.json(
                    {
                        error:
                            'Unable to determine proxy host',
                    },
                    {
                        status: 500,
                        headers:
                            corsHeaders(),
                    }
                );
            }

            const protocol =
                req.headers.get(
                    'x-forwarded-proto'
                ) ||
                (
                    req.nextUrl.protocol ||
                    'https:'
                ).replace(':', '');

            const proxyBaseUrl =
                `${protocol}://${host}/api/proxy/`;

            let rewrittenManifest;

            if (
                targetUrl.pathname
                    .toLowerCase()
                    .endsWith('.mpd') ||
                contentType
                    .toLowerCase()
                    .includes('dash+xml')
            ) {

                rewrittenManifest =
                    rewriteDashManifest(
                        manifestText,
                        targetUrl.toString(),
                        proxyBaseUrl
                    );

            } else {

                rewrittenManifest =
                    rewriteHlsManifest(
                        manifestText,
                        targetUrl.toString(),
                        proxyBaseUrl
                    );
            }

            responseHeaders.delete(
                'content-encoding'
            );

            responseHeaders.delete(
                'content-length'
            );

            if (
                targetUrl.pathname
                    .toLowerCase()
                    .endsWith('.mpd')
            ) {

                responseHeaders.set(
                    'Content-Type',
                    'application/dash+xml'
                );

            } else if (
                targetUrl.pathname
                    .toLowerCase()
                    .endsWith('.m3u8')
            ) {

                responseHeaders.set(
                    'Content-Type',
                    'application/vnd.apple.mpegurl'
                );
            }

            return new NextResponse(
                rewrittenManifest,
                {
                    status:
                        upstreamResponse.status,

                    statusText:
                        upstreamResponse.statusText,

                    headers:
                        responseHeaders,
                }
            );
        }

        return new NextResponse(
            upstreamResponse.body,
            {
                status:
                    upstreamResponse.status,

                statusText:
                    upstreamResponse.statusText,

                headers:
                    responseHeaders,
            }
        );

    } catch (error) {

        console.error(
            'CORS Proxy Error:',
            error
        );

        return NextResponse.json(
            {
                error:
                    'Proxy fetch failed',

                details:
                    error instanceof Error
                        ? error.message
                        : String(error),
            },
            {
                status: 502,
                headers:
                    corsHeaders(),
            }
        );
    }
}


/* =========================================================
   HTTP METHODS
========================================================= */

export async function GET(req) {
    return handleProxy(req);
}

export async function HEAD(req) {
    return handleProxy(req);
}

export async function POST(req) {
    return handleProxy(req);
}

export async function PUT(req) {
    return handleProxy(req);
}

export async function DELETE(req) {
    return handleProxy(req);
}


/* =========================================================
   CORS PREFLIGHT
========================================================= */

export async function OPTIONS() {
    return new NextResponse(
        null,
        {
            status: 204,
            headers:
                corsHeaders(),
        }
    );
}

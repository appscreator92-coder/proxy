import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/*
|--------------------------------------------------------------------------
| Allowed upstream hosts
|--------------------------------------------------------------------------
| IMPORTANT:
| Restrict this to domains you control.
|
| Example:
| const ALLOWED_HOSTS = new Set([
|     'media.example.com',
|     'cdn.example.com',
| ]);
|
| If you intentionally want to proxy arbitrary URLs, replace the
| allowlist check with your own access-control mechanism.
|--------------------------------------------------------------------------
*/

const ALLOWED_HOSTS = new Set([
    'your-domain.com',
    'cdn.your-domain.com',
]);

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

    /*
     * Decode the path safely.
     */
    try {
        encodedTarget = decodeURIComponent(encodedTarget);
    } catch {
        // Keep original value if decoding fails
    }

    /*
     * Some routing setups turn:
     *
     * https://example.com
     *
     * into:
     *
     * https:/example.com
     */
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

function copyResponseHeaders(upstreamHeaders) {
    const headers = new Headers();

    /*
     * Headers useful for HLS/DASH/video streaming.
     */
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
        const value = upstreamHeaders.get(name);

        if (value) {
            headers.set(name, value);
        }
    }

    /*
     * Add CORS headers.
     */
    const cors = corsHeaders();

    for (const [key, value] of Object.entries(cors)) {
        headers.set(key, value);
    }

    return headers;
}

async function handleProxy(req) {
    try {
        const rawTarget = getTargetFromPath(req);

        if (!rawTarget) {
            return NextResponse.json(
                {
                    error: 'Missing target URL',
                },
                {
                    status: 400,
                    headers: corsHeaders(),
                }
            );
        }

        let targetUrl;

        try {
            targetUrl = new URL(rawTarget);
        } catch {
            return NextResponse.json(
                {
                    error: 'Invalid target URL',
                    target: rawTarget,
                },
                {
                    status: 400,
                    headers: corsHeaders(),
                }
            );
        }

        /*
         * Only HTTP/HTTPS.
         */
        if (
            targetUrl.protocol !== 'http:' &&
            targetUrl.protocol !== 'https:'
        ) {
            return NextResponse.json(
                {
                    error: 'Only HTTP and HTTPS URLs are allowed',
                },
                {
                    status: 400,
                    headers: corsHeaders(),
                }
            );
        }

        /*
         * Security: restrict proxy targets.
         *
         * Add your actual CDN/stream domains to ALLOWED_HOSTS.
         */
        if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
            return NextResponse.json(
                {
                    error: 'Target host is not allowed',
                    host: targetUrl.hostname,
                },
                {
                    status: 403,
                    headers: corsHeaders(),
                }
            );
        }

        /*
         * Request headers sent to upstream server.
         */
        const upstreamHeaders = new Headers();

        const userAgent =
            req.headers.get('user-agent') || DEFAULT_UA;

        const referer =
            req.headers.get('referer') ||
            `${targetUrl.origin}/`;

        /*
         * Basic browser-like headers.
         */
        upstreamHeaders.set('User-Agent', userAgent);
        upstreamHeaders.set('Accept', '*/*');
        upstreamHeaders.set('Referer', referer);

        /*
         * Forward Origin only when supplied by client.
         */
        const origin = req.headers.get('origin');

        if (origin) {
            upstreamHeaders.set('Origin', origin);
        }

        /*
         * Critical for video seeking / DASH / HLS segments.
         */
        const range = req.headers.get('range');

        if (range) {
            upstreamHeaders.set('Range', range);
        }

        const accept = req.headers.get('accept');

        if (accept) {
            upstreamHeaders.set('Accept', accept);
        }

        /*
         * Forward content type for POST/PUT requests.
         */
        const contentType = req.headers.get('content-type');

        if (contentType) {
            upstreamHeaders.set('Content-Type', contentType);
        }

        /*
         * Authorization can be useful for streams you control.
         */
        const authorization = req.headers.get('authorization');

        if (authorization) {
            upstreamHeaders.set('Authorization', authorization);
        }

        /*
         * Do not forward Host manually.
         * fetch() sets it for the target URL.
         */

        const fetchOptions = {
            method: req.method,
            headers: upstreamHeaders,

            /*
             * Follow upstream redirects.
             */
            redirect: 'follow',

            /*
             * Do not cache the proxied response by Next.js.
             */
            cache: 'no-store',
        };

        /*
         * Forward request body for methods that have one.
         */
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

        const responseHeaders = copyResponseHeaders(
            upstreamResponse.headers
        );

        /*
         * Return upstream status and streaming body.
         */
        return new NextResponse(
            upstreamResponse.body,
            {
                status: upstreamResponse.status,
                statusText: upstreamResponse.statusText,
                headers: responseHeaders,
            }
        );

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
            {
                status: 502,
                headers: corsHeaders(),
            }
        );
    }
}

/*
|--------------------------------------------------------------------------
| GET
|--------------------------------------------------------------------------
*/
export async function GET(req) {
    return handleProxy(req);
}

/*
|--------------------------------------------------------------------------
| HEAD
|--------------------------------------------------------------------------
*/
export async function HEAD(req) {
    return handleProxy(req);
}

/*
|--------------------------------------------------------------------------
| POST
|--------------------------------------------------------------------------
*/
export async function POST(req) {
    return handleProxy(req);
}

/*
|--------------------------------------------------------------------------
| PUT
|--------------------------------------------------------------------------
*/
export async function PUT(req) {
    return handleProxy(req);
}

/*
|--------------------------------------------------------------------------
| DELETE
|--------------------------------------------------------------------------
*/
export async function DELETE(req) {
    return handleProxy(req);
}

/*
|--------------------------------------------------------------------------
| OPTIONS / CORS preflight
|--------------------------------------------------------------------------
*/
export async function OPTIONS() {
    return new NextResponse(null, {
        status: 204,
        headers: corsHeaders(),
    });
}

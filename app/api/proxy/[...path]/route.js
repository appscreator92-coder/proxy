import { NextResponse } from 'next/server';

async function handleProxy(req) {
    const urlPath = req.nextUrl.pathname; 
    const prefix = '/api/proxy/';
    let rawTarget = urlPath.startsWith(prefix) ? urlPath.slice(prefix.length) : '';

    if (!rawTarget) {
        return NextResponse.json({ error: 'Missing target URL' }, { status: 400 });
    }

    if (rawTarget.startsWith('http:/') && !rawTarget.startsWith('http://')) {
        rawTarget = rawTarget.replace('http:/', 'http://');
    } else if (rawTarget.startsWith('https:/') && !rawTarget.startsWith('https://')) {
        rawTarget = rawTarget.replace('https:/', 'https://');
    }

    const searchParams = req.nextUrl.search;
    if (searchParams) {
        rawTarget += searchParams;
    }

    try {
        const targetUrlObj = new URL(rawTarget);
        const targetOrigin = `${targetUrlObj.protocol}//${targetUrlObj.host}`;

        // Capture headers from the incoming request or use smart fallbacks
        const clientUserAgent = req.headers.get('user-agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
        const clientReferer = req.headers.get('referer') || targetOrigin + '/';
        const clientOrigin = req.headers.get('origin') || targetOrigin;

        // Fetch from target streaming server while forwarding/managing headers
        const apiResponse = await fetch(rawTarget, {
            method: req.method,
            headers: {
                'User-Agent': clientUserAgent,
                'Referer': clientReferer,
                'Origin': clientOrigin,
            },
        });

        const responseHeaders = new Headers();
        
        const contentType = apiResponse.headers.get('content-type');
        if (contentType) responseHeaders.set('Content-Type', contentType);
        
        const contentRange = apiResponse.headers.get('content-range');
        if (contentRange) responseHeaders.set('Content-Range', contentRange);

        // Permissive CORS headers for your video player
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        responseHeaders.set('Access-Control-Allow-Headers', '*');

        return new NextResponse(apiResponse.body, {
            status: apiResponse.status,
            headers: responseHeaders,
        });

    } catch (error) {
        return NextResponse.json({ error: 'Proxy fetch failed', details: error.message }, { status: 500 });
    }
}

export async function GET(req) { return handleProxy(req); }
export async function POST(req) { return handleProxy(req); }
export async function PUT(req) { return handleProxy(req); }
export async function DELETE(req) { return handleProxy(req); }
export async function OPTIONS() {
    return new NextResponse(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': '*',
        },
    });
}

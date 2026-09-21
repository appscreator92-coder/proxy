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
        // Fetch target URL without forwarding restricted headers (origin, referer, user-agent)
        const apiResponse = await fetch(rawTarget, {
            method: req.method,
            headers: {
                // Set a clean generic user-agent or omit it entirely
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                // Explicitly drop or override incoming Origin/Referer to prevent server blocks
            },
        });

        const data = await apiResponse.arrayBuffer(); // Use arrayBuffer to safely handle binary video chunks (.m4s, .ts)

        const response = new NextResponse(data, {
            status: apiResponse.status,
        });

        // Attach permissive CORS headers for your frontend player
        response.headers.set('Access-Control-Allow-Origin', '*');
        response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        response.headers.set('Access-Control-Allow-Headers', '*');

        const contentType = apiResponse.headers.get('content-type');
        if (contentType) {
            response.headers.set('Content-Type', contentType);
        }

        return response;
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

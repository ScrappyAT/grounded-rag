import { NextResponse } from 'next/server';

/**
 * Verify administrative authorization for protected operational endpoints
 * (/api/ingest, /api/jobs, /api/logs).
 * Requires a valid ADMIN_API_KEY passed via Bearer token or X-Admin-Key header.
 */
export function verifyAdminAuth(req: Request): boolean {
  const configuredAdminKey = process.env.ADMIN_API_KEY;

  // In production or read-only mode, if no admin key is configured, fail closed
  if (!configuredAdminKey || configuredAdminKey.trim() === '' || configuredAdminKey.includes('your_')) {
    return false;
  }

  // Check Authorization: Bearer <key>
  const authHeader = req.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    if (token === configuredAdminKey.trim()) {
      return true;
    }
  }

  // Check X-Admin-Key: <key>
  const customHeader = req.headers.get('x-admin-key');
  if (customHeader && customHeader.trim() === configuredAdminKey.trim()) {
    return true;
  }

  return false;
}

export function unauthorizedResponse(message = 'Unauthorized: Valid ADMIN_API_KEY required for administrative access.') {
  return NextResponse.json(
    {
      error: 'Unauthorized',
      message,
    },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Bearer error="invalid_token"',
      },
    }
  );
}

export function forbiddenResponse(message = 'Forbidden: Operation disabled in read-only production mode.') {
  return NextResponse.json(
    {
      error: 'Forbidden',
      message,
    },
    {
      status: 403,
    }
  );
}

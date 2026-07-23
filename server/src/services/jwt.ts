import jwt from 'jsonwebtoken';
import { appConfig } from '../shared/config/appConfig';

export interface AuthTokenPayload {
  sub: string;
  role: string;
  agencyId?: string;
}

function getSecret(): string {
  const secret = appConfig.jwtSecret;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

const EXPIRES_IN = '7d';

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: EXPIRES_IN });
}

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  try {
    return jwt.verify(token, getSecret()) as AuthTokenPayload;
  } catch {
    return null;
  }
}

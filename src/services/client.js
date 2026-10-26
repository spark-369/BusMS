import axios from 'axios';
import {
  applyServerRateLimit,
  guard as clientGuard,
} from '@/utils/clientRateLimit';

// On Vercel the frontend and API live on the same origin, so an empty baseURL
// (relative requests) is correct and avoids hardcoding localhost in production.
// Only set NEXT_PUBLIC_API_URL if you are calling an external API host.
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || '';

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

/**
 * Map a request to a client-side rate-limit action so the local bucket mirrors
 * the server policy that applies to it. Read endpoints share a coarse bucket;
 * mutating and abuse-sensitive endpoints get their own.
 */
export const resolveLimitAction = (config = {}) => {
  const url = String(config.url || '');
  const method = String(config.method || 'get').toLowerCase();

  if (url.includes('/api/auth/login')) return 'login';
  if (url.includes('/api/auth/register')) return 'register';
  if (url.includes('/api/dashboard') && method === 'post') return 'broadcast';
  if (url.includes('/api/notifications') && method === 'post') {
    return 'notification-send';
  }
  if (url.includes('/api/buspass') && method === 'put') return 'qr-verify';
  if (url.includes('/api/bookings') && method === 'post') return 'booking-create';
  if (url.includes('/api/feedback') && method === 'post') return 'feedback-submit';

  return method === 'get' ? 'api-read' : 'api-write';
};

// Request interceptor: attach the auth token and short-circuit requests the
// local limiter already knows will be rejected.
apiClient.interceptors.request.use(
  (config) => {
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('token');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }

      // Only gate explicitly-managed actions (login, register, bookings…) so
      // background polling never gets blocked by the client bucket — the server
      // remains authoritative for those.
      const action = resolveLimitAction(config);
      if (config.rateLimitAction !== false && action !== 'api-read') {
        const verdict = clientGuard(action);
        if (!verdict.allowed) {
          const error = new Error(verdict.message || 'Rate limit reached');
          error.isClientRateLimited = true;
          error.rateLimit = verdict;
          return Promise.reject(error);
        }
      }
    }

    return config;
  },
  (error) => Promise.reject(error),
);

// Response interceptor: clear the session on 401 and fold server rate limits
// back into the client-side cooldown so the UI can count down accurately.
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = '/login';
      }
    }

    if (error.response?.status === 429) {
      const action = resolveLimitAction(error.config || {});
      const cooldownMs = applyServerRateLimit(action, error);
      // Surface the wait so callers can show it without re-reading storage.
      error.rateLimitCooldownMs = cooldownMs;
      error.isServerRateLimited = true;
    }

    return Promise.reject(error);
  },
);

export default apiClient;


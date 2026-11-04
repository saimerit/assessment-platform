const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081/api';

export function getAuthToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('token');
}

export function getUserRole(): string | null {
    if (typeof window === 'undefined') return null;
    const user = localStorage.getItem('user');
    return user ? JSON.parse(user).role : null;
}

export async function fetchWithAuth(endpoint: string, options: RequestInit = {}) {
    const token = getAuthToken();
    const headers = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
    };

    const response = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers,
    });

    // A 403 means the identity is valid but lacks permission for this action.
    // Only an invalid/expired authentication token should clear the session.
    if (response.status === 401) {
        if (typeof window !== 'undefined') {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            window.location.href = '/login';
        }
    }

    return response;
}

// Centralized configuration for Deriv API

// Fallback to the old APP_ID if VITE_DERIV_APP_ID is not set in a .env file
export const APP_ID = import.meta.env.VITE_DERIV_APP_ID || '33I0ILZR9c4kZBvNkie3L';

// Automatically use the current origin (e.g., http://localhost:5173 or https://yourdomain.com)
export const getRedirectUri = () => {
  return window.location.origin;
};

/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== 'production';

/**
 * Next's development bundler and React Refresh both evaluate strings, so a
 * production-grade `script-src` without `'unsafe-eval'` stops the dev client from
 * hydrating at all — the page renders its server HTML and then never boots. The
 * relaxation is therefore scoped strictly to development; the shipped policy is unchanged.
 */
const scriptSrc = isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'";

const nextConfig = {
  reactStrictMode: true,
  // This application never renders remote HTML and never loads remote scripts or images.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          // No `connect-src` to technocore.chat: the browser never talks to the upstream
          // origin directly, only to this app's own bounded read-only routes.
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "img-src 'self' data:",
              "style-src 'self' 'unsafe-inline'",
              scriptSrc,
              "connect-src 'self'",
              "form-action 'none'",
              "frame-ancestors 'none'",
              "base-uri 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};


export default nextConfig;

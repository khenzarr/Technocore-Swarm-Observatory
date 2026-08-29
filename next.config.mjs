/** @type {import('next').NextConfig} */
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
              "script-src 'self' 'unsafe-inline'",
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
